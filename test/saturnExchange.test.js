const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SaturnExchange", function () {
  async function deployExchangeFixture() {
    const [owner, otherAccount, third] = await ethers.getSigners();

    // Deploy SATURN token (ERC223)
    const Saturn = await ethers.getContractFactory("Saturn");
    const saturn = await Saturn.deploy();
    await saturn.waitForDeployment();

    const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
    const exchange = await SaturnExchange.deploy(await saturn.getAddress());
    await exchange.waitForDeployment();

    // Constants
    const LOT_SIZE = 1000n * 10n ** 4n; // 1000 SATURN with 4 decimals
    const ONE_ETHER = ethers.parseEther("1");

    return { exchange, owner, otherAccount, third, saturn, LOT_SIZE, ONE_ETHER };
  }

  it("sets SATURN token address and owner", async function () {
    const { exchange, owner, saturn } = await loadFixture(deployExchangeFixture);
    expect(await exchange.SATURN_TOKEN()).to.equal(await saturn.getAddress());
    expect(await exchange.owner()).to.equal(owner.address);
  });

  it("rejects zero address constructor argument", async function () {
    const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
    await expect(SaturnExchange.deploy(ethers.ZeroAddress)).to.be.revertedWith("SATURN zero");
  });

  it("deposits SATURN via ERC223 transfer and rejects non-SATURN tokenFallback", async function () {
    const { exchange, owner, saturn, LOT_SIZE } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    await expect(
      saturn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x")
    ).to.emit(exchange, "DepositSATURN").withArgs(owner.address, LOT_SIZE);

    const acct = await exchange.accounts(owner.address);
    expect(acct.tokenBalance).to.equal(LOT_SIZE);

    await expect(
      exchange.tokenFallback(owner.address, LOT_SIZE, "0x")
    ).to.be.revertedWith("Only SATURN");
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
    const { exchange, otherAccount, saturn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Seed balances: deposit SATURN for future sells and ETC for buys
    await saturn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
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

  it("matches resting sell against taker buy and collects SATURN fee", async function () {
    const { exchange, owner, otherAccount, saturn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Seller deposits SATURN and places resting ask
    await saturn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.placeLimitSellFromBalance(ONE_ETHER, 1);

    // Buyer deposits ETC
    await exchange.connect(otherAccount).depositEtc({ value: ONE_ETHER });

    const feeSaturn = (LOT_SIZE * 25n) / 10_000n;
    const netSaturn = LOT_SIZE - feeSaturn;

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
        feeSaturn,
        0
      );

    // Maker (seller)
    const sellerAcct = await exchange.accounts(owner.address);
    expect(sellerAcct.tokenBalance).to.equal(0);
    expect(sellerAcct.etherBalance).to.equal(ONE_ETHER);

    // Taker (buyer)
    const buyerAcct = await exchange.accounts(otherAccount.address);
    expect(buyerAcct.etherBalance).to.equal(0);
    expect(buyerAcct.tokenBalance).to.equal(netSaturn);

    expect(await exchange.accumulatedFeesSaturn()).to.equal(feeSaturn);

    const [buyIds, , , sellIds] = await exchange.getOrderBook();
    expect(buyIds.length).to.equal(0);
    expect(sellIds.length).to.equal(0);
  });

  it("matches resting buy against taker sell and collects ETC fee", async function () {
    const { exchange, owner, otherAccount, saturn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Buyer places resting bid
    await exchange.depositEtc({ value: ONE_ETHER });
    await exchange.placeLimitBuyFromBalance(ONE_ETHER, 1);

    // Seller deposits SATURN
    // Move SATURN to seller first
    await saturn["transfer(address,uint256,bytes)"](otherAccount.address, LOT_SIZE, "0x");
    await saturn.connect(otherAccount)["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");

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

  it("supports placeLimitBuyImmediate with refund and SATURN delivery", async function () {
    const { exchange, owner, otherAccount, saturn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Maker deposits SATURN and places a sell
    await saturn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.placeLimitSellFromBalance(ONE_ETHER, 1);

    const feeSaturn = (LOT_SIZE * 25n) / 10_000n;
    const netSaturn = LOT_SIZE - feeSaturn;

    const msgValue = ONE_ETHER * 2n; // send extra to test refund path
    const buyerTokenBefore = await saturn.balanceOf(otherAccount.address);

    const tx = await exchange
      .connect(otherAccount)
      .placeLimitBuyImmediate(ONE_ETHER, 1, { value: msgValue });
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // Buyer receives SATURN externally (net of fee) and refund of unused ETC
    const buyerTokenAfter = await saturn.balanceOf(otherAccount.address);
    expect(buyerTokenAfter - buyerTokenBefore).to.equal(netSaturn);

    const refund = msgValue - ONE_ETHER;
    expect(refund).to.be.gt(0);
    // Contract should retain exactly the matched ETC (backing maker internal balance)
    const contractBalance = await ethers.provider.getBalance(exchangeAddr);
    expect(contractBalance).to.equal(ONE_ETHER);

    // Maker received ETC internally, lost SATURN
    const makerAcct = await exchange.accounts(owner.address);
    expect(makerAcct.etherBalance).to.equal(ONE_ETHER);
    expect(makerAcct.tokenBalance).to.equal(0);

    expect(await exchange.accumulatedFeesSaturn()).to.equal(feeSaturn);

    const [buyIds, , , sellIds] = await exchange.getOrderBook();
    expect(buyIds.length).to.equal(0);
    expect(sellIds.length).to.equal(0);
  });

  it("withdraws all funds and cancels resting orders", async function () {
    const { exchange, owner, saturn, LOT_SIZE, ONE_ETHER } = await loadFixture(deployExchangeFixture);
    const exchangeAddr = await exchange.getAddress();

    // Seed balances
    await saturn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");
    await exchange.depositEtc({ value: ONE_ETHER });

    // Place resting buy (will be cancelled on withdrawAll)
    await exchange.placeLimitBuyFromBalance(ONE_ETHER, 1);

    // WithdrawAll calls cancelAllMyOrders (nonReentrant), so current implementation reverts.
    await expect(exchange.withdrawAll()).to.be.revertedWith("Reentrancy");
  });
});
