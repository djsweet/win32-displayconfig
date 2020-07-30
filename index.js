"use strict";
const addon = require("bindings")("./win32_displayconfig");

class Win32Error extends Error {
  constructor(code) {
    super(`Win32 error code ${code}`);
    this.code = code;
  }
}

module.exports.queryDisplayConfig = () => {
  return new Promise((resolve, reject) => {
    const ran = addon.win32_queryDisplayConfig((err, result) => {
      if (err !== null) {
        reject(new Win32Error(err));
      } else {
        resolve(result);
      }
    });
    if (!ran) {
      resolve(undefined);
    }
  });
};

module.exports.extractDisplayConfig = async () => {
  const config = await module.exports.queryDisplayConfig();
  const ret = [];
  for (const { value, buffer: pathBuffer } of config.pathArray) {
    let inUse = value.flags & (1 === 1) ? true : false;
    const { sourceInfo, targetInfo } = value;

    const {
      modeInfoIdx: sourceModeIdx,
      adapterId: sourceAdapterId,
      id: sourceId,
    } = sourceInfo;
    const {
      adapterId,
      id,
      outputTechnology,
      rotation,
      scaling,
      modeInfoIdx: targetModeIdx,
    } = targetInfo;

    const sourceConfigId = {
      adapterId: sourceAdapterId,
      id: sourceId,
    };
    const targetConfigId = {
      adapterId,
      id,
    };

    const displayNameEntry = config.nameArray.find(
      (n) =>
        n.adapterId.LowPart === adapterId.LowPart &&
        n.adapterId.HighPart === adapterId.HighPart &&
        n.id === id &&
        n.outputTechnology &&
        outputTechnology &&
        n.monitorDevicePath.length > 0
    );

    if (displayNameEntry === undefined) {
      continue;
    }

    const sourceMode = config.modeArray[sourceModeIdx];
    const targetMode = config.modeArray[targetModeIdx];
    if (sourceMode === undefined) {
      continue;
    }
    if (targetMode === undefined) {
      // When we can't find the target mode, but _can_
      // find the source mode, that just means the monitor is off.
      inUse = false;
    }

    const sourceModeValue = sourceMode.value;
    if (sourceModeValue.infoType !== "source") {
      continue;
    }

    const { monitorFriendlyDeviceName, monitorDevicePath } = displayNameEntry;
    const output = {
      displayName: monitorFriendlyDeviceName,
      devicePath: monitorDevicePath,
      sourceConfigId,
      targetConfigId,
      inUse,
      outputTechnology,
      rotation,
      scaling,
      sourceMode: sourceModeValue.sourceMode,
      pathBuffer,
      sourceModeBuffer: sourceMode.buffer,
    };

    if (targetMode !== undefined) {
      const targetModeValue = targetMode.value;
      if (targetModeValue.infoType === "target") {
        output.targetVideoSignalInfo =
          targetModeValue.targetMode.targetVideoSignalInfo;
        output.targetModeBuffer = targetMode.buffer;
      }
    }

    ret.push(output);
  }
  return ret;
};

async function win32_toggleEnabledDisplays(args) {
  return new Promise((resolve, reject) => {
    const ran = addon.win32_toggleEnabledDisplays(args, (_, errorCode) => {
      if (errorCode === 0) {
        resolve();
      } else {
        reject(new Win32Error(errorCode));
      }
    });
    if (!ran) {
      resolve();
    }
  });
}

module.exports.toggleEnabledDisplays = async (args) => {
  const { persistent, enable: enablePaths, disable: disablePaths } = args;
  const enable = [];
  const disable = [];

  const displayConfig = await module.exports.extractDisplayConfig();
  for (const { devicePath, targetConfigId } of displayConfig) {
    if (Array.isArray(enablePaths) && enablePaths.indexOf(devicePath) >= 0) {
      enable.push(targetConfigId);
    }
    if (Array.isArray(disablePaths) && disablePaths.indexOf(devicePath) >= 0) {
      disable.push(targetConfigId);
    }
  }

  await win32_toggleEnabledDisplays({ enable, disable, persistent });
};

function setSubtract(left, right) {
  const ret = new Set();
  for (const entry of left) {
    if (!right.has(entry)) {
      ret.add(entry);
    }
  }
  return Array.from(ret);
}

function devicePathLookupForEnabledDisplayConfig(conf) {
  const ret = {};
  for (const entry of conf) {
    if (entry.inUse && entry.targetModeBuffer === undefined) {
      continue;
    }
    if (ret[entry.devicePath] !== undefined) {
      continue;
    }
    ret[entry.devicePath] = entry;
  }
  return ret;
}

module.exports.displayConfigForRestoration = async () => {
  const currentConfig = await module.exports.extractDisplayConfig();
  const ret = [];

  for (const entry of currentConfig) {
    if (!entry.inUse || entry.targetModeBuffer === undefined) {
      continue;
    }
    const {
      devicePath,
      pathBuffer,
      sourceModeBuffer,
      targetModeBuffer,
    } = entry;
    ret.push({
      devicePath,
      pathBuffer: pathBuffer.toString("base64"),
      sourceModeBuffer: sourceModeBuffer.toString("base64"),
      targetModeBuffer: targetModeBuffer.toString("base64"),
    });
  }

  return ret;
};

async function win32_restoreDisplayConfig(configs, persistent) {
  return new Promise((resolve, reject) => {
    const ran = addon.win32_restoreDisplayConfig(
      configs,
      (_, errorCode) => {
        if (errorCode === 0) {
          resolve();
        } else {
          reject(new Win32Error(errorCode));
        }
      },
      persistent
    );
    if (!ran) {
      resolve();
    }
  });
}

module.exports.restoreDisplayConfig = async (args) => {
  const devicePathNames = args.config
    .filter(({ targetModeBuffer }) => targetModeBuffer !== undefined)
    .map(({ devicePath }) => devicePath);
  const currentConfig = await module.exports.extractDisplayConfig();

  const givenAsSet = new Set(currentConfig.map(({ devicePath }) => devicePath));
  const expectedEnabledAsSet = new Set(devicePathNames);

  const missingEnabled = setSubtract(expectedEnabledAsSet, givenAsSet);

  // Here's the idea behind this:
  // We have a set of monitors we want enabled, and a set of monitors that are enabled.
  // Ideally, these should be identical sets. But it's also possible that
  //
  // 1. The current state has strictly more enabled monitors than the expected state
  // 2. The current state has strictly fewer enabled monitors than the expected state
  // 3. The current state has some monitors that are missing, and some that are unexpected.
  //
  // What we're about to do here is coerce the monitor state to the expected state; if more
  // monitors are enabled or disabled in the given state then that's fine, we're correcting
  // that away. The trick here is that the monitors in the expected state we _do_ want to
  // enable have to exist in the first place (we don't care about the ones we want to disable,
  // missing is also disabled if you squint hard enough).
  if (missingEnabled.length === 0) {
    const pathLookup = devicePathLookupForEnabledDisplayConfig(currentConfig);
    const coercedState = [];
    for (const entry of args.config) {
      if (entry.targetModeBuffer === undefined) {
        continue;
      }
      const currentConfigEntry = pathLookup[entry.devicePath];
      if (currentConfigEntry === undefined) {
        continue;
      }
      const { sourceConfigId, targetConfigId } = currentConfigEntry;
      const { pathBuffer, sourceModeBuffer, targetModeBuffer } = entry;
      coercedState.push({
        sourceConfigId,
        targetConfigId,
        pathBuffer: Buffer.from(pathBuffer, "base64"),
        sourceModeBuffer: Buffer.from(sourceModeBuffer, "base64"),
        targetModeBuffer: Buffer.from(targetModeBuffer, "base64"),
      });
    }

    await win32_restoreDisplayConfig(coercedState, args.persistent);
  } else {
    const seen = new Set();
    const enable = [];
    const disable = [];

    const notInUse = args.config
      .filter(({ targetModeBuffer }) => targetModeBuffer === undefined)
      .map(({ devicePath }) => devicePath);

    for (const devicePathName of devicePathNames) {
      if (!seen.has(devicePathName) && givenAsSet.has(devicePathName)) {
        enable.push(devicePathName);
        seen.add(devicePathName);
      }
    }
    for (const devicePathName of notInUse) {
      if (!seen.has(devicePathName) && givenAsSet.has(devicePathName)) {
        disable.push(devicePathName);
        seen.add(devicePathName);
      }
    }

    await module.exports.toggleEnabledDisplays({
      enable,
      disable,
      persistent: args.persistent,
    });
  }
};

let currentDisplayConfig;
const displayChangeCallbacks = new Set();

async function updateDisplayStateAndNotifyCallbacks() {
  try {
    currentDisplayConfig = await module.exports.extractDisplayConfig();
    for (const callback of Array.from(displayChangeCallbacks)) {
      callback(null, currentDisplayConfig);
    }
  } catch (e) {
    for (const callback of Array.from(displayChangeCallbacks)) {
      callback(e);
    }
  }
}

let currentDisplayConfigPromise = updateDisplayStateAndNotifyCallbacks();

function setupListenForDisplayChanges() {
  addon.win32_listenForDisplayChanges((err) => {
    if (err === null) {
      currentDisplayConfigPromise = currentDisplayConfigPromise.then(() =>
        updateDisplayStateAndNotifyCallbacks()
      );
    }
  });
}

module.exports.addDisplayChangeListener = (listener) => {
  if (displayChangeCallbacks.size === 0) {
    setupListenForDisplayChanges();
  }

  displayChangeCallbacks.add(listener);

  if (currentDisplayConfig !== undefined) {
    listener(null, currentDisplayConfig);
  }
};

module.exports.removeDisplayChangeListener = (listener) => {
  displayChangeCallbacks.delete(listener);
  if (displayChangeCallbacks.size === 0) {
    addon.win32_stopListeningForDisplayChanges();
  }
};
