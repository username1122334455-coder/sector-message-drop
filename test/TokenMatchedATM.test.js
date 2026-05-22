const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TokenMatchedATM", function () {
  const deposit = ethers.parseUnits("10", 18);
  const payout = ethers.parseEther("0.1");

  async function deployFixture() {
    const [owner, user, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Accepted Token", "TOK");
    const wrongToken = await Token.deploy("Wrong Token", "WRONG");

    const ATM = await ethers.getContractFactory("TokenMatchedATM");
    const atm = await ATM.deploy(owner.address, await token.getAddress(), deposit, payout);

    await token.mint(user.address, ethers.parseUnits("100", 18));
    await wrongToken.mint(user.address, ethers.parseUnits("100", 18));
    await owner.sendTransaction({ to: await atm.getAddress(), value: ethers.parseEther("1") });

    return { owner, user, other, token, wrongToken, atm };
  }

  it("allows a successful claim", async function () {
    const { user, token, atm } = await deployFixture();

    await token.connect(user).approve(await atm.getAddress(), deposit);

    await expect(atm.connect(user).claim())
      .to.emit(atm, "Claimed")
      .withArgs(user.address, deposit, payout);

    expect(await token.balanceOf(await atm.getAddress())).to.equal(deposit);
  });

  it("rejects wrong deposit amount through allowance/transfer failure", async function () {
    const { user, token, atm } = await deployFixture();

    await token.connect(user).approve(await atm.getAddress(), deposit - 1n);
    await expect(atm.connect(user).claim()).to.be.reverted;
  });

  it("rejects claims when vault funds are insufficient", async function () {
    const { owner, user, token, atm } = await deployFixture();

    await atm.connect(owner).withdrawNative(ethers.parseEther("1"));
    await token.connect(user).approve(await atm.getAddress(), deposit);

    await expect(atm.connect(user).claim())
      .to.be.revertedWithCustomError(atm, "InsufficientVaultFunds");
  });

  it("rejects claims when paused", async function () {
    const { owner, user, token, atm } = await deployFixture();

    await atm.connect(owner).pause();
    await token.connect(user).approve(await atm.getAddress(), deposit);

    await expect(atm.connect(user).claim()).to.be.revertedWithCustomError(atm, "Paused");
  });

  it("prevents reentrancy", async function () {
    const { user, token, atm } = await deployFixture();
    const Attacker = await ethers.getContractFactory("ReentrantClaimer");
    const attacker = await Attacker.connect(user).deploy(await atm.getAddress(), await token.getAddress());

    await token.mint(await attacker.getAddress(), deposit);

    await expect(attacker.connect(user).approveAndAttack(deposit)).to.be.reverted;
  });

  it("allows owner native withdrawals", async function () {
    const { owner, atm } = await deployFixture();

    await expect(atm.connect(owner).withdrawNative(payout))
      .to.emit(atm, "NativeWithdrawn")
      .withArgs(owner.address, payout);
  });

  it("rejects unsupported token claim path", async function () {
    const { user, wrongToken, atm } = await deployFixture();

    await wrongToken.connect(user).approve(await atm.getAddress(), deposit);

    await expect(atm.connect(user).claimWithToken(await wrongToken.getAddress()))
      .to.be.revertedWithCustomError(atm, "UnsupportedToken");
  });
});
