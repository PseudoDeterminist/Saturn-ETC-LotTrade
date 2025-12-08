const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Deploying Saturn token...");
  const Saturn = await ethers.getContractFactory("Saturn");
  const saturn = await Saturn.deploy();
  await saturn.waitForDeployment();
  const saturnAddress = await saturn.getAddress();
  console.log(`Saturn deployed to ${saturnAddress}`);

  console.log("Deploying SaturnExchange...");
  const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
  const exchange = await SaturnExchange.deploy(saturnAddress);
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  console.log(`SaturnExchange deployed to ${exchangeAddress}`);

  // Persist the latest deployment addresses for the UI/demo helpers.
  const outDir = path.join(__dirname, "..", "artifacts");
  const outFile = path.join(outDir, "latest-addresses.json");
  const payload = {
    network: hre.network.name,
    saturn: saturnAddress,
    saturnExchange: exchangeAddress,
    timestamp: new Date().toISOString()
  };
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(outFile, JSON.stringify(payload, null, 2));
  console.log(`Addresses saved to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
