const { ethers } = require("hardhat");

async function main() {
  const strnToken = process.env.STRN_TOKEN_ADDRESS;
  if (!strnToken || !ethers.isAddress(strnToken)) {
    throw new Error("Set STRN_TOKEN_ADDRESS to a valid STRN token address");
  }

  const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
  const exchange = await SaturnExchange.deploy(strnToken);
  await exchange.waitForDeployment();

  console.log(`SaturnExchange deployed to ${await exchange.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
