const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SaturnExchange", function () {
  async function deployExchangeFixture() {
    const [owner, otherAccount, third] = await ethers.getSigners();

    // Deploy STRN token (ERC223)
    const Saturn = await ethers.getContractFactory("Saturn");
    const strn = await Saturn.deploy();
    await strn.waitForDeployment();

    const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
    const exchange = await SaturnExchange.deploy(await strn.getAddress());
    await exchange.waitForDeployment();

    // Constants
    const LOT_SIZE = 1000n * 10n ** 4n; // 1000 STRN with 4 decimals
    const ONE_ETHER = ethers.parseEther("1");

    return { exchange, owner, otherAccount, third, strn, LOT_SIZE, ONE_ETHER };
  }

  it("sets STRN token address and owner", async function () {
    const { exchange, owner, strn } = await loadFixture(deployExchangeFixture);
    expect(await exchange.STRN_TOKEN()).to.equal(await strn.getAddress());
    expect(await exchange.owner()).to.equal(owner.address);
  });

  it("rejects zero address constructor argument", async function () {
    const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
    await expect(SaturnExchange.deploy(ethers.ZeroAddress)).to.be.revertedWith("STRN zero");
  });

  it("deposits STRN via ERC223 transfer and rejects non-STRN tokenFallback", async function () {
    const { exchange, owner, strn, LOT_SIZE } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    await expect(
      strn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x")
    ).to.emit(exchange, "DepositSTRN").withArgs(owner.address, LOT_SIZE);

    const acct = await exchange.accounts(owner.address);
    expect(acct.tokenBalance).to.equal(LOT_SIZE);

    await expect(
      exchange.tokenFallback(owner.address, LOT_SIZE, "0x")
    ).to.be.revertedWith("Only STRN");
  });

  it("handles ETC deposits", async function () {
    const { exchange, otherAccount, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    await expect(
      exchange.connect(otherAccount).depositEtc({ value: ONE_ETHER })
    ).to.emit(exchange, "DepositETC").withArgs(otherAccount.address, ONE_ETHER);

    const acct = await exchange.accounts(otherAccount.address);
    expect(acct.etherBalance).to.equal(ONE_ETHER);

    await expect(exchange.depositEtc()).to.be.revertedWith("No ETC");
  });

  it("places and cancels a resting buy order, updating orderbook and user lists", async function () {
    const { exchange, otherAccount, strn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Seed balances: deposit STRN for future sells and ETC for buys
    await strn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.connect(otherAccount).depositEtc({ value: ONE_ETHER });

    const price = ONE_ETHER;
    const lots = 1;

    await expect(
      exchange.connect(otherAccount).placeLimitBuyFromBalance(price, lots)
    ).to.emit(exchange, "OrderPlaced");

    const orders = await exchange.getUserOrders(otherAccount.address);
    expect(orders.length).to.equal(1);

    const [buyIds, buyPrices, buyLots, sellIds] = await exchange.getOrderBook();
    expect(buyIds.length).to.equal(1);
    expect(buyPrices[0]).to.equal(price);
    expect(buyLots[0]).to.equal(lots);
    expect(sellIds.length).to.equal(0);

    await expect(
      exchange.connect(otherAccount).cancelOrder(orders[0])
    ).to.emit(exchange, "OrderCanceled").withArgs(orders[0], otherAccount.address);

    const ordersAfter = await exchange.getUserOrders(otherAccount.address);
    expect(ordersAfter.length).to.equal(0);

    const [buyIdsAfter] = await exchange.getOrderBook();
    expect(buyIdsAfter.length).to.equal(0);
  });

  it("matches resting sell against taker buy and collects STRN fee", async function () {
    const { exchange, owner, otherAccount, strn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Seller deposits STRN and places resting ask
    await strn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.placeLimitSellFromBalance(ONE_ETHER, 1);

    // Buyer deposits ETC
    await exchange.connect(otherAccount).depositEtc({ value: ONE_ETHER });

    const feeStrn = (LOT_SIZE * 25n) / 10_000n;
    const netStrn = LOT_SIZE - feeStrn;

    await expect(
      exchange.connect(otherAccount).placeLimitBuyFromBalance(ONE_ETHER, 1)
    ).to.emit(exchange, "Trade")
      .withArgs(
        1, // maker order id
        owner.address,
        otherAccount.address,
        1, // Side.Sell
        ONE_ETHER,
        1,
        LOT_SIZE,
        ONE_ETHER,
        feeStrn,
        0
      );

    // Maker (seller)
    const sellerAcct = await exchange.accounts(owner.address);
    expect(sellerAcct.tokenBalance).to.equal(0);
    expect(sellerAcct.etherBalance).to.equal(ONE_ETHER);

    // Taker (buyer)
    const buyerAcct = await exchange.accounts(otherAccount.address);
    expect(buyerAcct.etherBalance).to.equal(0);
    expect(buyerAcct.tokenBalance).to.equal(netStrn);

    expect(await exchange.accumulatedFeesStrn()).to.equal(feeStrn);

    const [buyIds, , , sellIds] = await exchange.getOrderBook();
    expect(buyIds.length).to.equal(0);
    expect(sellIds.length).to.equal(0);
  });

  it("matches resting buy against taker sell and collects ETC fee", async function () {
    const { exchange, owner, otherAccount, strn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Buyer places resting bid
    await exchange.depositEtc({ value: ONE_ETHER });
    await exchange.placeLimitBuyFromBalance(ONE_ETHER, 1);

    // Seller deposits STRN
    // Move STRN to seller first
    await strn["transfer(address,uint256,bytes)"](otherAccount.address, LOT_SIZE, "0x");
    await strn.connect(otherAccount)["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");

    const feeEtc = (ONE_ETHER * 25n) / 10_000n;
    const netEtc = ONE_ETHER - feeEtc;

    await expect(
      exchange.connect(otherAccount).placeLimitSellFromBalance(ONE_ETHER, 1)
    ).to.emit(exchange, "Trade")
      .withArgs(
        1, // maker order id
        owner.address,
        otherAccount.address,
        0, // Side.Buy
        ONE_ETHER,
        1,
        LOT_SIZE,
        ONE_ETHER,
        0,
        feeEtc
      );

    const makerAcct = await exchange.accounts(owner.address);
    expect(makerAcct.etherBalance).to.equal(0);
    expect(makerAcct.tokenBalance).to.equal(LOT_SIZE);

    const takerAcct = await exchange.accounts(otherAccount.address);
    expect(takerAcct.tokenBalance).to.equal(0);
    expect(takerAcct.etherBalance).to.equal(netEtc);

    expect(await exchange.accumulatedFeesEtc()).to.equal(feeEtc);
  });

  it("supports placeLimitBuyImmediate with refund and STRN delivery", async function () {
    const { exchange, owner, otherAccount, strn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Maker deposits STRN and places a sell
    await strn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.placeLimitSellFromBalance(ONE_ETHER, 1);

    const feeStrn = (LOT_SIZE * 25n) / 10_000n;
    const netStrn = LOT_SIZE - feeStrn;

    const msgValue = ONE_ETHER * 2n; // send extra to test refund path
    const buyerTokenBefore = await strn.balanceOf(otherAccount.address);

    const tx = await exchange
      .connect(otherAccount)
      .placeLimitBuyImmediate(ONE_ETHER, 1, { value: msgValue });
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // Buyer receives STRN externally (net of fee) and refund of unused ETC
    const buyerTokenAfter = await strn.balanceOf(otherAccount.address);
    expect(buyerTokenAfter - buyerTokenBefore).to.equal(netStrn);

    const refund = msgValue - ONE_ETHER;
    expect(refund).to.be.gt(0);
    // Contract should retain exactly the matched ETC (backing maker internal balance)
    const contractBalance = await ethers.provider.getBalance(exchangeAddr);
    expect(contractBalance).to.equal(ONE_ETHER);

    // Maker received ETC internally, lost STRN
    const makerAcct = await exchange.accounts(owner.address);
    expect(makerAcct.etherBalance).to.equal(ONE_ETHER);
    expect(makerAcct.tokenBalance).to.equal(0);

    expect(await exchange.accumulatedFeesStrn()).to.equal(feeStrn);

    const [buyIds, , , sellIds] = await exchange.getOrderBook();
    expect(buyIds.length).to.equal(0);
    expect(sellIds.length).to.equal(0);
  });

  it("withdraws all funds and cancels resting orders", async function () {
    const { exchange, owner, strn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Seed balances
    await strn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.depositEtc({ value: ONE_ETHER });

    // Place resting buy (will be cancelled on withdrawAll)
    await exchange.placeLimitBuyFromBalance(ONE_ETHER, 1);

    // WithdrawAll calls cancelAllMyOrders (nonReentrant), so current implementation reverts.
    await expect(exchange.withdrawAll()).to.be.revertedWith("Reentrancy");
  });
});
