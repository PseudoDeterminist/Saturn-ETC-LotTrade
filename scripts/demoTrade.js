const { ethers } = require("hardhat");

// Quick demo: deploy Saturn token + exchange, deposit balances, place a sell,
// cross it with a buy, and show balances/orderbook before/after.
async function main() {
  const [deployer, alice, bob] = await ethers.getSigners();
  const LOT_SIZE = 1000n * 10n ** 4n; // 1000 STRN with 4 decimals
  const PRICE = ethers.parseEther("1");

  console.log("Deploying contracts...");
  const Saturn = await ethers.getContractFactory("Saturn");
  const strn = await Saturn.deploy();
  await strn.waitForDeployment();

  const Exchange = await ethers.getContractFactory("SaturnExchange");
  const exchange = await Exchange.deploy(await strn.getAddress());
  await exchange.waitForDeployment();

  const exchangeAddr = await exchange.getAddress();
  console.log(`STRN: ${await strn.getAddress()}`);
  console.log(`Exchange: ${exchangeAddr}`);

  const balances = async (label) => {
    const [depAcct, aliceAcct, bobAcct] = await Promise.all([
      exchange.accounts(deployer.address),
      exchange.accounts(alice.address),
      exchange.accounts(bob.address),
    ]);
    console.log(
      `${label} internal balances:\n` +
        `  deployer STRN=${depAcct.tokenBalance} ETC=${ethers.formatEther(depAcct.etherBalance)}\n` +
        `  alice    STRN=${aliceAcct.tokenBalance} ETC=${ethers.formatEther(aliceAcct.etherBalance)}\n` +
        `  bob      STRN=${bobAcct.tokenBalance} ETC=${ethers.formatEther(bobAcct.etherBalance)}`
    );
  };

  // Seller deposits STRN to exchange via ERC223 transfer
  console.log("Depositing STRN for deployer (seller)...");
  await strn["transfer(address,uint256,bytes)"](exchangeAddr, LOT_SIZE, "0x");

  // Buyer deposits ETC
  console.log("Depositing ETC for bob (buyer)...");
  await exchange.connect(bob).depositEtc({ value: ethers.parseEther("2") });

  await balances("After deposits");

  // Place a resting sell from deployer
  console.log("Placing resting sell (1 lot @ 1 ETC)...");
  await exchange.placeLimitSellFromBalance(PRICE, 1);

  // Cross with bob's buy
  console.log("Placing crossing buy from bob...");
  await exchange.connect(bob).placeLimitBuyFromBalance(PRICE, 1);

  await balances("After trade");

  const [buyIds, buyPrices, buyLots, sellIds, sellPrices, sellLots] = await exchange.getOrderBook();
  console.log("Orderbook:");
  console.log("  Buys:", buyIds.length ? buyIds.map((id, i) => ({ id, price: buyPrices[i].toString(), lots: buyLots[i].toString() })) : "empty");
  console.log("  Sells:", sellIds.length ? sellIds.map((id, i) => ({ id, price: sellPrices[i].toString(), lots: sellLots[i].toString() })) : "empty");

  console.log("Accumulated fees STRN:", (await exchange.accumulatedFeesStrn()).toString());
  console.log("Accumulated fees ETC:", ethers.formatEther(await exchange.accumulatedFeesEtc()));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
