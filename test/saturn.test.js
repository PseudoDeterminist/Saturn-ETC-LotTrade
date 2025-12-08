const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Saturn", function () {
  async function deploySaturn() {
    const [deployer, otherAccount] = await ethers.getSigners();
    const Saturn = await ethers.getContractFactory("Saturn");
    const saturn = await Saturn.deploy();
    await saturn.waitForDeployment();

    return { saturn, deployer, otherAccount };
  }

  it("mints total supply to deployer", async function () {
    const { saturn, deployer } = await loadFixture(deploySaturn);
    const expectedSupply = ethers.parseUnits("1000000000", 4); // 1B tokens, 4 decimals
    expect(await saturn.totalSupply()).to.equal(expectedSupply);
    expect(await saturn.balanceOf(deployer.address)).to.equal(expectedSupply);
  });

  it("transfers to an EOA", async function () {
    const { saturn, deployer, otherAccount } = await loadFixture(deploySaturn);
    const amount = ethers.parseUnits("25", 4);

    await expect(saturn.transfer(otherAccount.address, amount))
      .to.emit(saturn, "Transfer")
      .withArgs(deployer.address, otherAccount.address, amount);

    expect(await saturn.balanceOf(otherAccount.address)).to.equal(amount);
    const deployerBalance = await saturn.balanceOf(deployer.address);
    expect(deployerBalance).to.equal((await saturn.totalSupply()) - amount);
  });

  it("reverts when balance is insufficient", async function () {
    const { saturn, otherAccount } = await loadFixture(deploySaturn);
    const amount = ethers.parseUnits("1", 4);
    await expect(
      saturn.connect(otherAccount).transfer(ethers.ZeroAddress, amount)
    ).to.be.reverted;
  });

  it("calls tokenFallback when transferring to a contract", async function () {
    const { saturn, deployer } = await loadFixture(deploySaturn);
    const Receiver = await ethers.getContractFactory("TestReceiver");
    const receiver = await Receiver.deploy();
    await receiver.waitForDeployment();

    const data = ethers.toUtf8Bytes("hello");
    const amount = ethers.parseUnits("10", 4);
    const receiverAddress = await receiver.getAddress();

    await expect(
      saturn["transfer(address,uint256,bytes)"](receiverAddress, amount, data)
    )
      .to.emit(receiver, "Received")
      .withArgs(deployer.address, amount, data)
      .and.to.emit(saturn, "ERC223Transfer")
      .withArgs(deployer.address, receiverAddress, amount, data);

    expect(await saturn.balanceOf(receiverAddress)).to.equal(amount);
  });
});
