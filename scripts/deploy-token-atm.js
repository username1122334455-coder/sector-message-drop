const { ethers } = require("hardhat");

async function main() {
  const owner = process.env.ATM_OWNER;
  const acceptedToken = process.env.ACCEPTED_TOKEN;
  const requiredDeposit = process.env.REQUIRED_DEPOSIT;
  const payoutAmount = process.env.PAYOUT_AMOUNT;

  if (!owner || !ethers.isAddress(owner)) {
    throw new Error("Set ATM_OWNER to the owner wallet address.");
  }

  if (!acceptedToken || !ethers.isAddress(acceptedToken)) {
    throw new Error("Set ACCEPTED_TOKEN to the ERC-20 token address.");
  }

  if (!requiredDeposit || !payoutAmount) {
    throw new Error("Set REQUIRED_DEPOSIT and PAYOUT_AMOUNT in base units.");
  }

  const ATM = await ethers.getContractFactory("TokenMatchedATM");
  const atm = await ATM.deploy(owner, acceptedToken, requiredDeposit, payoutAmount);
  await atm.waitForDeployment();

  console.log("TokenMatchedATM deployed:", await atm.getAddress());
  console.log("Owner:", owner);
  console.log("Accepted token:", acceptedToken);
  console.log("Required deposit:", requiredDeposit);
  console.log("Payout amount:", payoutAmount);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
