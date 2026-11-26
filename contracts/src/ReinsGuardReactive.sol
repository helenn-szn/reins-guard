// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../lib/reactive-lib/src/interfaces/IReactive.sol";
import "../lib/reactive-lib/src/abstract-base/AbstractReactive.sol";

/// @title ReinsGuardReactive
/// @notice Runs on Reactive Network. Watches a ReinsVault on another chain and keeps its own
///         copy of each user's money, bills, floor and habits (persistent state in the ReactVM).
///         After every deposit, bill change, bill payment or purchase - and on a timer, so bills
///         coming due are noticed with nothing happening - it decides:
///
///           need = safety floor + every unpaid bill due within the next 14 days
///           free = pot - need
///           free < 0           -> Safe Mode on, every habit paused
///           free >= 0          -> Safe Mode off; habits switch back on in order, each only if
///                                 what's left still covers its weekly amount
///
///         and calls the vault back whenever that decision (or the free amount) changes. No keepers, no relayers,
///         and it keeps working while Reins and its AI are offline.
contract ReinsGuardReactive is IReactive, AbstractReactive {
    uint256 public constant HORIZON = 14 days;
    uint256 public constant MAX_HABITS = 8;
    uint64 private constant CALLBACK_GAS = 300_000;

    // ReinsVault event signatures
    uint256 private constant T_DEPOSITED = uint256(keccak256("Deposited(address,address,uint256,uint256,uint256)"));
    uint256 private constant T_WITHDRAWN = uint256(keccak256("Withdrawn(address,uint256,uint256,uint256)"));
    uint256 private constant T_FLOOR = uint256(keccak256("FloorSet(address,uint256,uint256)"));
    uint256 private constant T_BILL_SET = uint256(keccak256("BillSet(address,uint256,uint256,uint256,bool,uint256)"));
    uint256 private constant T_BILL_PAID = uint256(keccak256("BillPaid(address,uint256,uint256,uint256,bool,uint256,uint256)"));
    uint256 private constant T_HABIT = uint256(keccak256("HabitSet(address,uint256,uint256,uint256,bool,uint256)"));
    uint256 private constant T_SPENT = uint256(keccak256("Spent(address,uint256,address,uint256,uint256,uint256)"));

    uint256 public immutable originChainId;
    address public immutable vault;
    uint256 public immutable cronTopic; // 0 = no timer

    struct Bill {
        uint256 amount;
        uint256 dueAt;
        bool active;
    }

    struct Habit {
        uint256 weekly;
        bool enabled;
    }

    struct User {
        bool known;
        uint256 balance;
        uint256 floor;
        uint256 lastAt; // latest origin time seen for this user
        uint256[] billIds;
        bool sent; // has a decision been sent yet?
        bool sentSafe;
        uint256 sentMask;
        int256 sentFree;
    }

    // ReactVM state (persists between events)
    mapping(address => User) internal users;
    mapping(address => mapping(uint256 => Bill)) internal bills;
    mapping(address => mapping(uint256 => bool)) internal billSeen;
    mapping(address => mapping(uint256 => Habit)) internal habits;
    address[] public userList;

    event Decided(address indexed user, bool safeMode, int256 free, uint256 allowedMask, uint256 at, bool sent);

    constructor(uint256 originChainId_, address vault_, uint256 cronTopic_) payable {
        originChainId = originChainId_;
        vault = vault_;
        cronTopic = cronTopic_;
        if (!vm) {
            uint256[7] memory topics = [T_DEPOSITED, T_WITHDRAWN, T_FLOOR, T_BILL_SET, T_BILL_PAID, T_HABIT, T_SPENT];
            for (uint256 i = 0; i < topics.length; i++) {
                service.subscribe(originChainId_, vault_, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            }
            if (cronTopic_ != 0) {
                service.subscribe(block.chainid, address(service), cronTopic_, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            }
        }
    }

    function react(LogRecord calldata log) external vmOnly {
        if (cronTopic != 0 && log.topic_0 == cronTopic && log._contract == address(service)) {
            _onTimer();
            return;
        }
        if (log.chain_id != originChainId || log._contract != vault) return;

        address user = address(uint160(log.topic_1));
        User storage u = users[user];
        if (!u.known) {
            u.known = true;
            userList.push(user);
        }
        uint256 t = log.topic_0;
        uint256 at;

        if (t == T_DEPOSITED) {
            (, uint256 balance, uint256 at_) = abi.decode(log.data, (uint256, uint256, uint256));
            u.balance = balance;
            at = at_;
        } else if (t == T_WITHDRAWN) {
            (, uint256 balance, uint256 at_) = abi.decode(log.data, (uint256, uint256, uint256));
            u.balance = balance;
            at = at_;
        } else if (t == T_FLOOR) {
            (uint256 floor, uint256 at_) = abi.decode(log.data, (uint256, uint256));
            u.floor = floor;
            at = at_;
        } else if (t == T_BILL_SET) {
            uint256 id = log.topic_2;
            (uint256 amount, uint256 dueAt, bool active, uint256 at_) = abi.decode(log.data, (uint256, uint256, bool, uint256));
            _track(user, id);
            bills[user][id] = Bill(amount, dueAt, active);
            at = at_;
        } else if (t == T_BILL_PAID) {
            uint256 id = log.topic_2;
            (uint256 amount, uint256 nextDueAt, bool active, uint256 balance, uint256 at_) =
                abi.decode(log.data, (uint256, uint256, bool, uint256, uint256));
            _track(user, id);
            bills[user][id] = Bill(amount, nextDueAt, active); // paid once: counted again only when next due
            u.balance = balance;
            at = at_;
        } else if (t == T_HABIT) {
            uint256 id = log.topic_2;
            if (id >= MAX_HABITS) return;
            (, uint256 weekly, bool enabled, uint256 at_) = abi.decode(log.data, (uint256, uint256, bool, uint256));
            habits[user][id] = Habit(weekly, enabled);
            at = at_;
        } else if (t == T_SPENT) {
            (,, uint256 balance, uint256 at_) = abi.decode(log.data, (address, uint256, uint256, uint256));
            u.balance = balance;
            at = at_;
        } else {
            return;
        }

        if (at > u.lastAt) u.lastAt = at;
        _evaluate(user, u.lastAt, false);
    }

    /// @dev On each timer tick, re-check everyone as time moves on (a bill entering the 14-day window).
    function _onTimer() internal {
        for (uint256 i = 0; i < userList.length; i++) {
            address user = userList[i];
            User storage u = users[user];
            uint256 at = block.timestamp > u.lastAt ? block.timestamp : u.lastAt;
            _evaluate(user, at, true);
        }
    }

    function _track(address user, uint256 id) internal {
        if (!billSeen[user][id]) {
            billSeen[user][id] = true;
            users[user].billIds.push(id);
        }
    }

    /// @notice What the guard would decide for a user at a given time.
    function decide(address user, uint256 at) public view returns (bool safeMode, int256 free, uint256 mask, uint256 need) {
        User storage u = users[user];
        need = u.floor;
        for (uint256 i = 0; i < u.billIds.length; i++) {
            Bill storage b = bills[user][u.billIds[i]];
            if (b.active && b.dueAt <= at + HORIZON) need += b.amount;
        }
        free = int256(u.balance) - int256(need);
        if (free < 0) return (true, free, 0, need);

        uint256 left = uint256(free);
        for (uint256 id = 0; id < MAX_HABITS; id++) {
            Habit storage h = habits[user][id];
            if (h.enabled && left >= h.weekly) {
                mask |= (1 << id);
                left -= h.weekly;
            }
        }
        return (false, free, mask, need);
    }

    function _evaluate(address user, uint256 at, bool timer) internal {
        (bool safe, int256 free, uint256 mask,) = decide(user, at);
        User storage u = users[user];
        // Always report a new decision; also report a new "free to spend" figure after real events
        // (a timer tick only calls back if the decision itself changes).
        bool changed = !u.sent || u.sentSafe != safe || u.sentMask != mask || (!timer && u.sentFree != free);
        if (changed) {
            u.sent = true;
            u.sentSafe = safe;
            u.sentMask = mask;
            u.sentFree = free;
            bytes memory payload = abi.encodeWithSignature(
                "applyGuard(address,address,bool,int256,uint256,uint256)", address(0), user, safe, free, mask, at
            );
            emit Callback(originChainId, vault, CALLBACK_GAS, payload);
        }
        if (changed || !timer) emit Decided(user, safe, free, mask, at, changed);
    }

    function userCount() external view returns (uint256) {
        return userList.length;
    }
}
