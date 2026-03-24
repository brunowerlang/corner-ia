const fs = require("fs");

// Read the extracted function
const fnSrc = fs.readFileSync(__dirname + "/_test_js.js", "utf8");

// Evaluate it to define getClientJS
eval(fnSrc);

// Get the output
const jsOutput = getClientJS();

// Write output for inspection
fs.writeFileSync(__dirname + "/_test_output.js", jsOutput);
console.log("Output length:", jsOutput.length);

// Try to parse it
try {
  new Function(jsOutput);
  console.log("JS PARSES OK");
} catch (e) {
  console.error("PARSE ERROR:", e.message);
  
  // Find approximate location
  const lines = jsOutput.split("\n");
  for (let i = 0; i < lines.length; i++) {
    try {
      new Function(lines.slice(0, i + 1).join("\n") + "\n}".repeat(20));
    } catch (e2) {
      if (e2.message !== e.message) continue;
      console.error("Error likely near line", i + 1, ":", lines[i].substring(0, 100));
      break;
    }
  }
}
