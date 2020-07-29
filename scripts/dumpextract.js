const w32mon = require("../index");
const util = require("util");

w32mon.extractDisplayConfig().then((output) => {
  console.log(util.inspect(output, { depth: 10 }));
});
