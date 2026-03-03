// test_import_meta_main.ts - Test that import.meta.main is correct for main vs imported modules
import { checkMain } from "./check_main";
console.log("=== import.meta.main Test ===\n");
console.log(`In main module: import.meta.main = ${import.meta.main}`);
const importedMain = checkMain();
console.log("\nExpected:");
console.log("  Main module: true");
console.log("  Imported module: false");
const mainCorrect = import.meta.main === true;
const importedCorrect = importedMain === false;
if (mainCorrect && importedCorrect) {
	console.log("\n=== All tests passed! ===");
} else {
	console.log("\n=== TESTS FAILED ===");
	if (!mainCorrect) console.log("  Main module should be true");
	if (!importedCorrect) console.log("  Imported module should be false");
}
