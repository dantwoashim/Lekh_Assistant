import { convert } from "../src/engine/index";

const inputs = process.argv.slice(2);
const samples = inputs.length > 0 ? inputs : ["namaste", "mero naam prabin ho", "dhanyabad, pheri bhetaula"];

for (const input of samples) {
  const result = convert(input, { mode: "romanized-strict" });
  console.log(`${input}  ->  ${result.output}`);
}
