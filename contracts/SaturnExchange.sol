// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC223 interface for SATURN
interface IERC223 {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice Saturn large-lot SATURN/ETC limit-order exchange (v0.1)
contract SaturnExchange {
    // ------------------------------------------------------------
    // Types and constants
    // ------------------------------------------------------------

    enum Side { Buy, Sell }

    struct Account {
        uint256 tokenBalance; // SATURN internal balance (in smallest units, 4 decimals)
        uint256 etherBalance; // ETC internal balance (wei)
    }

    struct Order {
        // Orderbook doubly-linked list (per side)
        uint64 prev;
        uint64 next;

        // Per-user doubly-linked list
        uint64 userPrev;
        uint64 userNext;

        // Payload
        address user;
        Side    side;
        uint128 pricePerLot; // ETC per lot in wei
        uint128 lots;        // integer number of lots (1 lot = 1000 SATURN)
    }

    // SATURN has 4 decimals, 1 lot = 1000 SATURN => 1000 * 10^4 units
    uint256 public constant SATURN_DECIMALS = 4;
    uint256 public constant LOT_SIZE = 1000 * (10 ** SATURN_DECIMALS); // 1000 SATURN

    // Fee: basis points (1e4 = 100%)
    uint16 public constant TAKER_FEE_BPS = 25;  // 0.25%

    // ------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------

    address public immutable SATURN_TOKEN;
    address public owner;
    bool    public emergencyMode;

    mapping(address => Account) public accounts;

    // Orders
    mapping(uint64 => Order) public orders;
    uint64 public nextOrderId = 1;

    // Orderbook heads/tails
    uint64 public buyHead;
    uint64 public buyTail;

    uint64 public sellHead;
    uint64 public sellTail;

    // Per-user order lists (doubly-linked)
    mapping(address => uint64) public userFirstOrder;
    mapping(address => uint64) public userLastOrder;

    // Fee accumulation
    uint256 public accumulatedFeesEtc;
    uint256 public accumulatedFeesSaturn;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status = _NOT_ENTERED;

    // ------------------------------------------------------------
    // Events
    // ------------------------------------------------------------

    event DepositSATURN(address indexed user, uint256 amount);
    event DepositETC(address indexed user, uint256 amount);
    event WithdrawAll(address indexed user, uint256 saturnAmount, uint256 etcAmount);

    event OrderPlaced(
        uint64 indexed orderId,
        address indexed user,
        Side side,
        uint128 pricePerLot,
        uint128 lots
    );

    event OrderCanceled(uint64 indexed orderId, address indexed user);

    event Trade(
        uint64 indexed makerOrderId,
        address indexed maker,
        address indexed taker,
        Side   side,          // side of the *maker* (Buy or Sell)
        uint128 pricePerLot,
        uint128 lots,
        uint256 grossSaturn,
        uint256 grossEtc,
        uint256 feeSaturn,
        uint256 feeEtc
    );

    event EmergencyModeSet(bool enabled);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------

    modifier nonReentrant() {
        require(_status != _ENTERED, "Reentrancy");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier tradingAllowed() {
        require(!emergencyMode, "Trading disabled");
        _;
    }

    // ------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------

    constructor(address _saturn) {
        require(_saturn != address(0), "SATURN zero");
        SATURN_TOKEN = _saturn;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------
    // Ownership / emergency
    // ------------------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setEmergencyMode(bool enabled) external onlyOwner {
        emergencyMode = enabled;
        emit EmergencyModeSet(enabled);
    }

    // ------------------------------------------------------------
    // Deposits
    // ------------------------------------------------------------

    /// @notice ERC223 tokenFallback – only accept SATURN, treat as deposit for v0.1
    function tokenFallback(address from, uint256 value, bytes calldata /*data*/) external {
        require(msg.sender == SATURN_TOKEN, "Only SATURN");
        accounts[from].tokenBalance += value;
        emit DepositSATURN(from, value);
    }

    /// @notice Deposit ETC into internal balance
    function depositEtc() external payable nonReentrant {
        require(msg.value > 0, "No ETC");
        accounts[msg.sender].etherBalance += msg.value;
        emit DepositETC(msg.sender, msg.value);
    }

    // ------------------------------------------------------------
    // Views: balances, orders, orderbook
    // ------------------------------------------------------------

    function getUserBalances(address user) external view returns (uint256 saturn, uint256 etc) {
        Account storage a = accounts[user];
        return (a.tokenBalance, a.etherBalance);
    }

    function getOrder(uint64 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    /// @notice Return IDs of all active orders for a user
    function getUserOrders(address user) external view returns (uint64[] memory ids) {
        // Count first
        uint64 current = userFirstOrder[user];
        uint256 count;
        while (current != 0) {
            count++;
            current = orders[current].userNext;
        }

        ids = new uint64[](count);
        current = userFirstOrder[user];
        uint256 i;
        while (current != 0) {
            ids[i++] = current;
            current = orders[current].userNext;
        }
    }

    /// @notice Return full buy/sell book (IDs, pricePerLot, lots)
    function getOrderBook()
        external
        view
        returns (
            uint64[] memory buyIds,
            uint128[] memory buyPrices,
            uint128[] memory buyLots,
            uint64[] memory sellIds,
            uint128[] memory sellPrices,
            uint128[] memory sellLots_
        )
    {
        // Count buys
        uint64 cur = buyHead;
        uint256 bCount;
        while (cur != 0) {
            bCount++;
            cur = orders[cur].next;
        }

        // Count sells
        cur = sellHead;
        uint256 sCount;
        while (cur != 0) {
            sCount++;
            cur = orders[cur].next;
        }

        buyIds    = new uint64[](bCount);
        buyPrices = new uint128[](bCount);
        buyLots   = new uint128[](bCount);

        sellIds    = new uint64[](sCount);
        sellPrices = new uint128[](sCount);
        sellLots_  = new uint128[](sCount);

        // Fill buys
        cur = buyHead;
        uint256 i;
        while (cur != 0) {
            Order storage o = orders[cur];
            buyIds[i]      = cur;
            buyPrices[i]   = o.pricePerLot;
            buyLots[i]     = o.lots;
            i++;
            cur = o.next;
        }

        // Fill sells
        cur = sellHead;
        i = 0;
        while (cur != 0) {
            Order storage o2 = orders[cur];
            sellIds[i]       = cur;
            sellPrices[i]    = o2.pricePerLot;
            sellLots_[i]     = o2.lots;
            i++;
            cur = o2.next;
        }
    }

    // ------------------------------------------------------------
    // Internal helpers: user-locked computation (v0.1 simple model)
    // ------------------------------------------------------------

    /// @notice Compute how much of user's balances are already "locked" by their active orders.
    /// For v0.1 this is recomputed on demand. Good enough for large-lot, low-frequency Saturn.
    function _computeUserLocked(address user)
        internal
        view
        returns (uint256 lockedSaturn, uint256 lockedEtc)
    {
        uint64 cur = userFirstOrder[user];
        while (cur != 0) {
            Order storage o = orders[cur];
            uint256 lots = uint256(o.lots);
            if (o.side == Side.Sell) {
                lockedSaturn += lots * LOT_SIZE;               // SATURN locked
            } else {
                lockedEtc  += lots * uint256(o.pricePerLot);  // ETC locked
            }
            cur = o.userNext;
        }
    }

    // ------------------------------------------------------------
    // Internal helpers: orderbook list management
    // ------------------------------------------------------------

    function _linkUserOrder(address user, uint64 orderId) internal {
        uint64 first = userFirstOrder[user];
        if (first == 0) {
            userFirstOrder[user] = orderId;
            userLastOrder[user]  = orderId;
        } else {
            uint64 last = userLastOrder[user];
            orders[last].userNext = orderId;
            orders[orderId].userPrev = last;
            userLastOrder[user] = orderId;
        }
    }

    function _unlinkUserOrder(address user, uint64 orderId) internal {
        Order storage o = orders[orderId];
        uint64 up = o.userPrev;
        uint64 un = o.userNext;

        if (up != 0) {
            orders[up].userNext = un;
        } else {
            // was head
            userFirstOrder[user] = un;
        }

        if (un != 0) {
            orders[un].userPrev = up;
        } else {
            // was tail
            userLastOrder[user] = up;
        }

        o.userPrev = 0;
        o.userNext = 0;
    }

    // Insert into buy list (sorted: highest price first)
    function _insertBuyOrder(uint64 orderId) internal {
        Order storage o = orders[orderId];
        uint128 price = o.pricePerLot;

        if (buyHead == 0) {
            buyHead = orderId;
            buyTail = orderId;
            return;
        }

        // If better than current head, become new head
        if (price > orders[buyHead].pricePerLot) {
            o.next = buyHead;
            o.prev = 0;
            orders[buyHead].prev = orderId;
            buyHead = orderId;
            return;
        }

        // Traverse until we find insertion point
        uint64 cur = buyHead;
        while (true) {
            Order storage c = orders[cur];
            uint64 nxt = c.next;

            // Maintain price-time priority:
            // skip all orders with price >= new price
            if (nxt == 0 || orders[nxt].pricePerLot < price) {
                // Insert after cur
                o.prev = cur;
                o.next = nxt;
                c.next = orderId;
                if (nxt != 0) {
                    orders[nxt].prev = orderId;
                } else {
                    buyTail = orderId;
                }
                break;
            }

            cur = nxt;
        }
    }

    // Insert into sell list (sorted: lowest price first)
    function _insertSellOrder(uint64 orderId) internal {
        Order storage o = orders[orderId];
        uint128 price = o.pricePerLot;

        if (sellHead == 0) {
            sellHead = orderId;
            sellTail = orderId;
            return;
        }

        // If better (lower) than current head, become new head
        if (price < orders[sellHead].pricePerLot) {
            o.next = sellHead;
            o.prev = 0;
            orders[sellHead].prev = orderId;
            sellHead = orderId;
            return;
        }

        uint64 cur = sellHead;
        while (true) {
            Order storage c = orders[cur];
            uint64 nxt = c.next;

            // Skip all prices <= new price (to keep time priority)
            if (nxt == 0 || orders[nxt].pricePerLot > price) {
                // Insert after cur
                o.prev = cur;
                o.next = nxt;
                c.next = orderId;
                if (nxt != 0) {
                    orders[nxt].prev = orderId;
                } else {
                    sellTail = orderId;
                }
                break;
            }

            cur = nxt;
        }
    }

    function _removeFromSideList(uint64 orderId) internal {
        Order storage o = orders[orderId];
        uint64 p = o.prev;
        uint64 n = o.next;

        if (o.side == Side.Buy) {
            if (p != 0) {
                orders[p].next = n;
            } else {
                buyHead = n;
            }
            if (n != 0) {
                orders[n].prev = p;
            } else {
                buyTail = p;
            }
        } else {
            if (p != 0) {
                orders[p].next = n;
            } else {
                sellHead = n;
            }
            if (n != 0) {
                orders[n].prev = p;
            } else {
                sellTail = p;
            }
        }

        o.prev = 0;
        o.next = 0;
    }

    // ------------------------------------------------------------
    // Core trading: limit orders from internal balances
    // ------------------------------------------------------------

    /// @notice Place a limit buy using internal ETC balance; remainder rests as an order.
    function placeLimitBuyFromBalance(
        uint128 pricePerLot,
        uint128 lots
    ) external nonReentrant tradingAllowed {
        require(lots > 0, "Zero lots");
        require(pricePerLot > 0, "Zero price");

        Account storage acct = accounts[msg.sender];

        // Check available ETC after accounting for existing locked
        (, uint256 lockedEtc) = _computeUserLocked(msg.sender);
        uint256 maxEtcNeeded = uint256(pricePerLot) * uint256(lots);
        require(acct.etherBalance >= lockedEtc + maxEtcNeeded, "Insufficient ETC");

        _placeLimitInternal(msg.sender, Side.Buy, pricePerLot, lots, true);
    }

    /// @notice Place a limit sell using internal SATURN balance; remainder rests as an order.
    function placeLimitSellFromBalance(
        uint128 pricePerLot,
        uint128 lots
    ) external nonReentrant tradingAllowed {
        require(lots > 0, "Zero lots");
        require(pricePerLot > 0, "Zero price");

        Account storage acct = accounts[msg.sender];

        (uint256 lockedSaturn, ) = _computeUserLocked(msg.sender);
        uint256 saturnNeeded = uint256(lots) * LOT_SIZE;
        require(acct.tokenBalance >= lockedSaturn + saturnNeeded, "Insufficient SATURN");

        _placeLimitInternal(msg.sender, Side.Sell, pricePerLot, lots, true);
    }

    /// @notice Place a limit BUY with immediate delivery:
    /// user sends ETC directly; any matches execute, SATURN is sent out, leftover ETC refunded.
    /// No resting order is created.
    function placeLimitBuyImmediate(
        uint128 pricePerLot,
        uint128 lotsMax
    ) external payable nonReentrant tradingAllowed {
        require(lotsMax > 0, "Zero lots");
        require(pricePerLot > 0, "Zero price");
        require(msg.value > 0, "No ETC");

        Account storage acct = accounts[msg.sender];

        // Snapshot internal balances
        uint256 etherBefore = acct.etherBalance;
        uint256 tokenBefore = acct.tokenBalance;

        // Credit ETC to internal balance for the duration of this call
        acct.etherBalance = etherBefore + msg.value;

        // Perform matching with no remainder resting
        _placeLimitInternal(msg.sender, Side.Buy, pricePerLot, lotsMax, false);

        // Read post-trade balances
        uint256 etherAfter = acct.etherBalance;
        uint256 tokenAfter = acct.tokenBalance;

        // Compute deltas
        uint256 saturnDelta = tokenAfter > tokenBefore ? (tokenAfter - tokenBefore) : 0;
        uint256 etcSpent  = (etherBefore + msg.value) - etherAfter;

        // Reset internal balances to pre-call state
        acct.etherBalance = etherBefore;
        acct.tokenBalance = tokenBefore;

        // External settlement

        // 1) Send SATURN out
        if (saturnDelta > 0) {
            require(IERC223(SATURN_TOKEN).transfer(msg.sender, saturnDelta), "SATURN transfer failed");
        }

        // 2) Refund unused ETC
        uint256 refund = msg.value - etcSpent;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "Refund failed");
        }
    }

    /// @dev Core matching engine for limit orders.
    /// If placeRemainder == true, any unfilled lots rest in the book.
    function _placeLimitInternal(
        address taker,
        Side side,
        uint128 limitPricePerLot,
        uint128 lotsIn,
        bool   placeRemainder
    ) internal {
        uint128 lotsRemaining = lotsIn;

        if (side == Side.Buy) {
            // Match against best sells
            while (lotsRemaining > 0 && sellHead != 0) {
                Order storage ask = orders[sellHead];
                if (ask.pricePerLot > limitPricePerLot) {
                    // Best ask is too expensive
                    break;
                }

                uint128 tradeLots = ask.lots;
                if (tradeLots > lotsRemaining) {
                    tradeLots = lotsRemaining;
                }

                // Compute gross amounts
                uint256 grossSaturn = uint256(tradeLots) * LOT_SIZE;
                uint256 grossEtc    = uint256(tradeLots) * uint256(ask.pricePerLot);

                // Check taker ETC balance
                Account storage takerAcct = accounts[taker];
                require(takerAcct.etherBalance >= grossEtc, "Taker ETC insufficient");

                // Apply taker fee in SATURN
                uint256 feeSaturn = (grossSaturn * TAKER_FEE_BPS) / 10_000;
                uint256 netSaturn = grossSaturn - feeSaturn;

                // Maker is ask.user
                address maker = ask.user;
                Account storage makerAcct = accounts[maker];

                // Maker must have enough SATURN
                require(makerAcct.tokenBalance >= grossSaturn, "Maker SATURN insufficient");

                // Transfer balances
                // Maker: gives SATURN, receives ETC
                makerAcct.tokenBalance -= grossSaturn;
                makerAcct.etherBalance += grossEtc;

                // Taker: gives ETC, receives SATURN (minus fee)
                takerAcct.etherBalance -= grossEtc;
                takerAcct.tokenBalance += netSaturn;

                accumulatedFeesSaturn += feeSaturn;

                // Emit Trade
                emit Trade(
                    sellHead,
                    maker,
                    taker,
                    Side.Sell,
                    ask.pricePerLot,
                    tradeLots,
                    grossSaturn,
                    grossEtc,
                    feeSaturn,
                    0
                );

                // Update order lots / remove if filled
                ask.lots -= tradeLots;
                lotsRemaining -= tradeLots;

                if (ask.lots == 0) {
                    // Remove fully filled order
                    uint64 filledId = sellHead;
                    _removeFromSideList(filledId);
                    _unlinkUserOrder(maker, filledId);
                    delete orders[filledId];
                }
            }

            // Place remainder as resting buy order
            if (placeRemainder && lotsRemaining > 0) {
                _createAndInsertRestingOrder(taker, Side.Buy, limitPricePerLot, lotsRemaining);
            }
        } else {
            // side == Sell: match against best buys
            while (lotsRemaining > 0 && buyHead != 0) {
                Order storage bid = orders[buyHead];
                if (bid.pricePerLot < limitPricePerLot) {
                    // Best bid is too cheap
                    break;
                }

                uint128 tradeLots = bid.lots;
                if (tradeLots > lotsRemaining) {
                    tradeLots = lotsRemaining;
                }

                uint256 grossSaturn = uint256(tradeLots) * LOT_SIZE;
                uint256 grossEtc    = uint256(tradeLots) * uint256(bid.pricePerLot);

                Account storage takerAcct = accounts[taker];
                require(takerAcct.tokenBalance >= grossSaturn, "Taker SATURN insufficient");

                uint256 feeEtc = (grossEtc * TAKER_FEE_BPS) / 10_000;
                uint256 netEtc = grossEtc - feeEtc;

                address maker = bid.user;
                Account storage makerAcct = accounts[maker];

                // Maker: gives ETC, receives SATURN
                require(makerAcct.etherBalance >= grossEtc, "Maker ETC insufficient");
                makerAcct.etherBalance -= grossEtc;
                makerAcct.tokenBalance += grossSaturn;

                // Taker: gives SATURN, receives ETC (net)
                takerAcct.tokenBalance -= grossSaturn;
                takerAcct.etherBalance += netEtc;

                accumulatedFeesEtc += feeEtc;

                emit Trade(
                    buyHead,
                    maker,
                    taker,
                    Side.Buy,
                    bid.pricePerLot,
                    tradeLots,
                    grossSaturn,
                    grossEtc,
                    0,
                    feeEtc
                );

                bid.lots -= tradeLots;
                lotsRemaining -= tradeLots;

                if (bid.lots == 0) {
                    uint64 filledId = buyHead;
                    _removeFromSideList(filledId);
                    _unlinkUserOrder(maker, filledId);
                    delete orders[filledId];
                }
            }

            if (placeRemainder && lotsRemaining > 0) {
                _createAndInsertRestingOrder(taker, Side.Sell, limitPricePerLot, lotsRemaining);
            }
        }
    }

    function _createAndInsertRestingOrder(
        address user,
        Side side,
        uint128 pricePerLot,
        uint128 lots
    ) internal {
        uint64 id = nextOrderId++;
        Order storage o = orders[id];
        o.user = user;
        o.side = side;
        o.pricePerLot = pricePerLot;
        o.lots = lots;

        // Link in user list
        _linkUserOrder(user, id);

        // Link in side list
        if (side == Side.Buy) {
            _insertBuyOrder(id);
        } else {
            _insertSellOrder(id);
        }

        emit OrderPlaced(id, user, side, pricePerLot, lots);
    }

    // ------------------------------------------------------------
    // Cancels & withdrawals
    // ------------------------------------------------------------

    function cancelOrder(uint64 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.user != address(0), "No order");
        require(msg.sender == o.user, "Not owner");

        _removeFromSideList(orderId);
        _unlinkUserOrder(msg.sender, orderId);
        delete orders[orderId];

        emit OrderCanceled(orderId, msg.sender);
    }

    function cancelAllMyOrders() public nonReentrant {
        uint64 cur = userFirstOrder[msg.sender];
        while (cur != 0) {
            uint64 next = orders[cur].userNext;
            _removeFromSideList(cur);
            _unlinkUserOrder(msg.sender, cur);
            emit OrderCanceled(cur, msg.sender);
            delete orders[cur];
            cur = next;
        }
    }

    function withdrawAll() external nonReentrant {
        // Cancel all orders for safety & correctness
        cancelAllMyOrders();

        Account storage a = accounts[msg.sender];
        uint256 saturn = a.tokenBalance;
        uint256 etc  = a.etherBalance;

        a.tokenBalance = 0;
        a.etherBalance = 0;

        if (saturn > 0) {
            require(IERC223(SATURN_TOKEN).transfer(msg.sender, saturn), "SATURN transfer failed");
        }

        if (etc > 0) {
            (bool ok, ) = payable(msg.sender).call{value: etc}("");
            require(ok, "ETC send failed");
        }

        emit WithdrawAll(msg.sender, saturn, etc);
    }

    // ------------------------------------------------------------
    // Fee withdrawal
    // ------------------------------------------------------------

    function withdrawFees(address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "Zero recipient");
        uint256 etc = accumulatedFeesEtc;
        uint256 saturn = accumulatedFeesSaturn;

        accumulatedFeesEtc = 0;
        accumulatedFeesSaturn = 0;

        if (etc > 0) {
            (bool ok, ) = payable(recipient).call{value: etc}("");
            require(ok, "ETC fee send failed");
        }
        if (saturn > 0) {
            require(IERC223(SATURN_TOKEN).transfer(recipient, saturn), "SATURN fee transfer failed");
        }
    }

    // ------------------------------------------------------------
    // Fallback / receive
    // ------------------------------------------------------------

    receive() external payable {
        // Disallow random ETC sends; require using depositEtc or placeLimitBuyImmediate
        revert("Use depositEtc() or placeLimitBuyImmediate()");
    }
}
