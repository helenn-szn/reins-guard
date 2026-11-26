// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../lib/reactive-lib/src/abstract-base/AbstractCallback.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ReinsVault
/// @notice The spending pot for Reins on Base Sepolia. It holds the user's money, their bills,
///         safety floor and habits, and pays out. It is both the origin of the events that
///         ReinsGuardReactive watches and the destination of its callbacks.
///
///         Bills can always be paid. Habit purchases (coffee, rides, ...) only go through when
///         the reactive contract has allowed that habit, which it decides after every deposit,
///         bill and purchase: next 2 weeks of bills + safety floor first, habits only from what's left.
contract ReinsVault is AbstractCallback {
    uint256 public constant MAX_HABITS = 8;

    struct Bill {
        string name;
        address payee;
        uint256 amount;
        uint256 dueAt;
        uint256 interval; // 0 = one-off, else repeats (e.g. 30 days)
        bool active;
    }

    struct Habit {
        string name;
        uint256 cap; // max per purchase
        uint256 weekly; // what to keep aside for it each week before it may run
        bool enabled; // switched on by the user
    }

    struct Guard {
        bool evaluated; // has the reactive contract decided yet?
        bool safeMode;
        int256 free; // money left after bills due in 2 weeks + floor (negative = short)
        uint256 allowedMask; // bit i = habit i may spend
        uint256 at; // origin time the decision was based on
        uint256 updatedAt; // when the callback landed
    }

    IERC20 public immutable token;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public floorOf;
    mapping(address => address) public agentOf; // e.g. the Reins agent wallet
    mapping(address => Bill[]) internal _bills;
    mapping(address => mapping(uint256 => Habit)) public habitOf;
    mapping(address => Guard) public guardOf;

    // Events the reactive contract subscribes to (user is always topic_1, `at` is last in data)
    event Deposited(address indexed user, address indexed from, uint256 amount, uint256 balance, uint256 at);
    event Withdrawn(address indexed user, uint256 amount, uint256 balance, uint256 at);
    event FloorSet(address indexed user, uint256 floor, uint256 at);
    event BillSet(address indexed user, uint256 indexed id, uint256 amount, uint256 dueAt, bool active, uint256 at);
    event BillPaid(address indexed user, uint256 indexed id, uint256 amount, uint256 nextDueAt, bool active, uint256 balance, uint256 at);
    event HabitSet(address indexed user, uint256 indexed id, uint256 cap, uint256 weekly, bool enabled, uint256 at);
    event Spent(address indexed user, uint256 indexed habitId, address to, uint256 amount, uint256 balance, uint256 at);

    // Written when a reactive callback lands
    event GuardApplied(address indexed user, bool safeMode, int256 free, uint256 allowedMask, uint256 at);
    event AgentSet(address indexed user, address agent);

    /// @param callbackProxy Reactive's callback proxy on this chain
    constructor(address callbackProxy, IERC20 token_) payable AbstractCallback(callbackProxy) {
        token = token_;
    }

    // ---------- money in / out ----------

    /// @notice Anyone can top up a user's pot (salary, a friend, the user themselves).
    function depositFor(address user, uint256 amount) public {
        require(amount > 0, "amount 0");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        balanceOf[user] += amount;
        emit Deposited(user, msg.sender, amount, balanceOf[user], block.timestamp);
    }

    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "not enough in pot");
        balanceOf[msg.sender] -= amount;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, amount, balanceOf[msg.sender], block.timestamp);
    }

    // ---------- rules the user sets ----------

    function setFloor(uint256 floor) external {
        floorOf[msg.sender] = floor;
        emit FloorSet(msg.sender, floor, block.timestamp);
    }

    function setAgent(address agent) external {
        agentOf[msg.sender] = agent;
        emit AgentSet(msg.sender, agent);
    }

    function addBill(string calldata name, address payee, uint256 amount, uint256 dueAt, uint256 interval)
        external
        returns (uint256 id)
    {
        require(amount > 0 && payee != address(0), "bad bill");
        id = _bills[msg.sender].length;
        _bills[msg.sender].push(Bill(name, payee, amount, dueAt, interval, true));
        emit BillSet(msg.sender, id, amount, dueAt, true, block.timestamp);
    }

    function cancelBill(uint256 id) external {
        Bill storage b = _bills[msg.sender][id];
        b.active = false;
        emit BillSet(msg.sender, id, b.amount, b.dueAt, false, block.timestamp);
    }

    function setHabit(uint256 id, string calldata name, uint256 cap, uint256 weekly, bool enabled) external {
        require(id < MAX_HABITS, "habit id");
        habitOf[msg.sender][id] = Habit(name, cap, weekly, enabled);
        emit HabitSet(msg.sender, id, cap, weekly, enabled, block.timestamp);
    }

    // ---------- paying ----------

    modifier onlyUserOrAgent(address user) {
        require(msg.sender == user || (agentOf[user] != address(0) && msg.sender == agentOf[user]), "not your pot");
        _;
    }

    /// @notice Bills are always allowed: they are what Safe Mode protects.
    function payBill(address user, uint256 id) external onlyUserOrAgent(user) {
        Bill storage b = _bills[user][id];
        require(b.active, "bill not active");
        require(balanceOf[user] >= b.amount, "not enough in pot");
        balanceOf[user] -= b.amount;
        if (b.interval > 0) b.dueAt += b.interval;
        else b.active = false;
        require(token.transfer(b.payee, b.amount), "transfer failed");
        emit BillPaid(user, id, b.amount, b.dueAt, b.active, balanceOf[user], block.timestamp);
    }

    /// @notice A habit purchase. Only goes through if the reactive guard has allowed this habit.
    function spend(address user, uint256 habitId, address to, uint256 amount) external onlyUserOrAgent(user) {
        require(habitId < MAX_HABITS, "habit id");
        Habit storage h = habitOf[user][habitId];
        require(h.enabled, "habit switched off");
        require(amount <= h.cap, "over habit limit");
        Guard storage g = guardOf[user];
        require(g.evaluated && (g.allowedMask >> habitId) & 1 == 1, "paused by Reins Guard");
        require(balanceOf[user] >= amount, "not enough in pot");
        balanceOf[user] -= amount;
        require(token.transfer(to, amount), "transfer failed");
        emit Spent(user, habitId, to, amount, balanceOf[user], block.timestamp);
    }

    // ---------- reactive callback ----------

    /// @notice Called by Reactive Network with the guard's decision.
    /// @param rvm Replaced by Reactive with the ReactVM id (the deployer of the reactive contract).
    function applyGuard(address rvm, address user, bool safeMode, int256 free, uint256 allowedMask, uint256 at)
        external
        authorizedSenderOnly
        rvmIdOnly(rvm)
    {
        Guard storage g = guardOf[user];
        if (g.evaluated && at < g.at) return; // an older decision arrived late
        guardOf[user] = Guard(true, safeMode, free, allowedMask, at, block.timestamp);
        emit GuardApplied(user, safeMode, free, allowedMask, at);
    }

    // ---------- views ----------

    function billCount(address user) external view returns (uint256) {
        return _bills[user].length;
    }

    function billOf(address user, uint256 id) external view returns (Bill memory) {
        return _bills[user][id];
    }

    function billsOf(address user) external view returns (Bill[] memory) {
        return _bills[user];
    }
}
