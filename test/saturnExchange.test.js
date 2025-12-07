const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SaturnExchange", function () {
  async function deployExchangeFixture() {
    const [owner, otherAccount] = await ethers.getSigners();
    const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
    const exchange = await SaturnExchange.deploy(owner.address);
    await exchange.waitForDeployment();

    return { exchange, owner, otherAccount };
  }

  it("sets STRN token address and owner", async function () {
    const { exchange, owner } = await loadFixture(deployExchangeFixture);
    expect(await exchange.STRN_TOKEN()).to.equal(owner.address);
    expect(await exchange.owner()).to.equal(owner.address);
  });

  it("rejects zero address constructor argument", async function () {
    const SaturnExchange = await ethers.getContractFactory("SaturnExchange");
    await expect(SaturnExchange.deploy(ethers.ZeroAddress)).to.be.revertedWith("STRN zero");
  });
});
