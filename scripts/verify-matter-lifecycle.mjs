// Exercise Homebridge's real registration, name-only cache restore, and plugin reclamation.
// No radio, commissioning, or network advertisement is started.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const host = path.resolve(process.argv[2] ?? 'node_modules/homebridge');
const hostRequire = createRequire(path.join(host, 'package.json'));
const hostImport = (file) => import(pathToFileURL(path.join(host, file)).href);
const matterImport = (name) =>
  import(pathToFileURL(hostRequire.resolve(name).replace('/dist/cjs/', '/dist/esm/')).href);
const { Endpoint, ServerNode, Environment } = await matterImport('@matter/main');
const { AggregatorEndpoint } = await matterImport('@matter/main/endpoints/aggregator');
const { MatterServer } = await hostImport('dist/matter/server.js');
const { MatterAccessoryCache } = await hostImport('dist/matter/accessoryCache.js');
const { deviceTypes } = await hostImport('dist/matter/types.js');
const { Service: S, Characteristic: C } = require('hap-nodejs');
const { MatterAccessories } = require('../dist/matter/MatterAccessories.js');
const storage = await mkdtemp(path.join(os.tmpdir(), 'zwave-matter-lifecycle-'));
Environment.default.vars.set('storage.path', storage);
let node, hostServer, bridge;
const updates = [];
async function start() {
  node = await ServerNode.create({ id: 'lifecycle', network: { port: 0 } });
  const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
  await node.add(aggregator);
  hostServer = new MatterServer({ uniqueId: 'AABBCCDDEEFF', storagePath: storage });
  hostServer.serverNode = node;
  hostServer.aggregator = aggregator;
  hostServer.isRunning = true;
}
const api = {
  deviceTypes,
  status: { Failure: class extends Error {}, NotFound: class extends Error {} },
  registerPlatformAccessories: (...args) => hostServer.registerPlatformAccessories(...args),
  unregisterPlatformAccessories: (...args) => hostServer.unregisterPlatformAccessories(...args),
  updateAccessoryState: (...args) => {
    const pending = hostServer.updateAccessoryState(...args);
    updates.push(pending);
    return pending;
  },
};
const platform = {
  api: { matter: api },
  Service: S,
  Characteristic: C,
  log: { debug() {}, info() {}, warn: console.warn, error: console.error },
};
function service(Type, values, subtype = '0') {
  const s = new Type('Device', subtype);
  for (const [type, value] of values) {
    const characteristic = s.getCharacteristic(type);
    characteristic.onGet(() => characteristic.value).updateValue(value);
  }
  return s;
}
function accessory(uuid, services) {
  return {
    platformAccessory: {
      UUID: uuid,
      displayName: uuid,
      services,
      getService: (type) => services.find((s) => s.UUID === type.UUID),
    },
    node: { nodeId: 8, getDefinedValueIDs: () => [] },
  };
}
async function publish(a) {
  bridge.add(a);
  await bridge.publishPending();
}
function endpointGraph(uuid) {
  const internal = hostServer.accessories.get(uuid);
  assert(internal, `${uuid} was not registered`);
  return [internal.endpoint, ...(internal._parts ?? []).map((p) => p.endpoint)];
}
function assertMeasurement(uuid, cluster, expected) {
  const endpoint = endpointGraph(uuid).find((e) => e.state[cluster]);
  assert(endpoint, `${uuid} has no ${cluster} endpoint`);
  assert.equal(endpoint.state[cluster].measuredValue, expected, `${uuid}: ${cluster}`);
}
function restore(serialized) {
  const type = (name) => Object.values(deviceTypes).find((t) => t.name === name);
  const handlers = (clusters) => Object.fromEntries(Object.keys(clusters).map((key) => [key, {}]));
  return {
    UUID: serialized.uuid,
    displayName: serialized.displayName,
    deviceType: type(serialized.deviceType.name),
    manufacturer: serialized.manufacturer,
    model: serialized.model,
    serialNumber: serialized.serialNumber,
    context: serialized.context,
    clusters: serialized.clusters,
    handlers: handlers(serialized.clusters),
    _restoredFromCache: true,
    registered: false,
    parts: serialized.parts?.map((p) => ({
      ...p,
      deviceType: type(p.deviceType.name),
      handlers: handlers(p.clusters),
    })),
  };
}
const air = service(S.AirQualitySensor, [
  [C.AirQuality, 3],
  [C.VOCDensity, 150],
  [C.PM2_5Density, 12],
]);
const co2 = service(S.CarbonDioxideSensor, [
  [C.CarbonDioxideDetected, 0],
  [C.CarbonDioxideLevel, 750],
]);
const standalone = accessory('standalone-air', [air, co2]);
const childAir = service(
  S.AirQualitySensor,
  [
    [C.AirQuality, 4],
    [C.VOCDensity, 200],
    [C.PM2_5Density, 14],
  ],
  '2',
);
const childCo2 = service(
  S.CarbonDioxideSensor,
  [
    [C.CarbonDioxideDetected, 0],
    [C.CarbonDioxideLevel, 850],
  ],
  '2',
);
const covering = service(
  S.WindowCovering,
  [
    [C.CurrentPosition, 80],
    [C.TargetPosition, 80],
  ],
  '1',
);
const composed = accessory('covering-with-air', [covering, childAir, childCo2]);
const firstSwitch = service(S.Switch, [[C.On, true]], '0');
const secondSwitch = service(S.Switch, [[C.On, false]], '2');
const rootBattery = service(
  S.Battery,
  [
    [C.BatteryLevel, 80],
    [C.StatusLowBattery, 0],
  ],
  '0',
);
const partBattery = service(
  S.Battery,
  [
    [C.BatteryLevel, 15],
    [C.StatusLowBattery, 1],
  ],
  '2',
);
const batteries = accessory('endpoint-batteries', [
  firstSwitch,
  secondSwitch,
  rootBattery,
  partBattery,
]);
const batteryOnly = accessory('battery-only', [
  service(S.Battery, [
    [C.BatteryLevel, 50],
    [C.StatusLowBattery, 0],
  ]),
]);
const all = [standalone, composed, batteries, batteryOnly];
let cached = [],
  numbers;
const cache = new MatterAccessoryCache(storage, 'test');
try {
  for (let restart = 0; restart < 3; restart++) {
    await start();
    for (const record of cached)
      await hostServer.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        restore(record),
      ]);
    bridge = new MatterAccessories(platform);
    for (const record of cached)
      bridge.configureCachedAccessory({ UUID: record.uuid, displayName: record.displayName });
    for (const a of all) await publish(a);
    const currentNumbers = all.map((a) =>
      endpointGraph(a.platformAccessory.UUID).map((e) => e.number),
    );
    if (numbers)
      assert.deepEqual(currentNumbers, numbers, 'Endpoint identities changed across restart');
    numbers = currentNumbers;
    assertMeasurement('standalone-air', 'carbonDioxideConcentrationMeasurement', 750);
    assertMeasurement(
      'standalone-air',
      'totalVolatileOrganicCompoundsConcentrationMeasurement',
      150,
    );
    assertMeasurement('standalone-air', 'pm25ConcentrationMeasurement', 12);
    assertMeasurement('covering-with-air', 'carbonDioxideConcentrationMeasurement', 850);
    assertMeasurement(
      'covering-with-air',
      'totalVolatileOrganicCompoundsConcentrationMeasurement',
      200,
    );
    assertMeasurement('covering-with-air', 'pm25ConcentrationMeasurement', 14);
    const batteryEndpoints = endpointGraph('endpoint-batteries');
    assert.equal(batteryEndpoints[0].state.powerSource.batPercentRemaining, 160);
    assert.equal(batteryEndpoints[1].state.powerSource.batPercentRemaining, 30);
    assert.equal(endpointGraph('battery-only')[0].state.powerSource.batPercentRemaining, 100);
    partBattery.updateCharacteristic(C.BatteryLevel, 10);
    await Promise.all(updates.splice(0));
    assert.equal(batteryEndpoints[0].state.powerSource.batPercentRemaining, 160);
    assert.equal(batteryEndpoints[1].state.powerSource.batPercentRemaining, 20);
    partBattery.updateCharacteristic(C.BatteryLevel, 15);
    await Promise.all(updates.splice(0));
    childCo2.updateCharacteristic(C.CarbonDioxideLevel, 900);
    await Promise.all(updates.splice(0));
    assertMeasurement('covering-with-air', 'carbonDioxideConcentrationMeasurement', 900);
    childCo2.updateCharacteristic(C.CarbonDioxideLevel, 850);
    await Promise.all(updates.splice(0));
    cached = [...hostServer.accessories.values()].map((a) =>
      JSON.parse(JSON.stringify(cache.serializeAccessory(a))),
    );
    bridge.stop();
    await node.close();
    node = undefined;
    console.log(`PASS raw sensor registration, state updates and identities: start ${restart + 1}`);
  }
} finally {
  bridge?.stop();
  if (node) await node.close();
  await rm(storage, { recursive: true, force: true });
}
