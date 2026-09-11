const hre = require("hardhat");
const registryJson = require("../shared/DocumentRegistry.json");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const backendAccount =
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  console.log("Deployer:", deployer.address);
  console.log("Granting UPLOADER_ROLE to:", backendAccount);

  const registry = await hre.ethers.getContractAt(
    registryJson.abi,
    registryJson.address,
    deployer
  );

  const tx = await registry.grantUploaderRole(backendAccount);

  console.log("Transaction:", tx.hash);

  await tx.wait();

  console.log("SUCCESS: Backend account now has UPLOADER_ROLE");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});