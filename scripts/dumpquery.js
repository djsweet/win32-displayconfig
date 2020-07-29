const w32mon = require("../index");
const util = require("util");

w32mon.queryDisplayConfig().then((config) => {
  const pathArray = config.pathArray.map((pa) => pa.value);
  const modeArray = config.modeArray.map((ma) => ma.value);
  console.log(
    util.inspect(
      { pathArray, modeArray, nameArray: config.nameArray },
      { depth: 10 }
    )
  );
});
