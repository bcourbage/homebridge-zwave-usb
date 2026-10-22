// Optional integration check against an installed Homebridge 2 Matter runtime.
// Usage: node scripts/verify-matter-host.mjs /path/to/node_modules/homebridge
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const host = path.resolve(process.argv[2] ?? 'node_modules/homebridge');
const load = (file) => import(pathToFileURL(path.join(host, file)).href);
const { deviceTypes } = await load('dist/matter/types.js');
const { AccessoryManager } = await load('dist/matter/server/AccessoryManager.js');
const hostRequire = createRequire(path.join(host, 'package.json'));
const { Endpoint, ServerNode, Environment } = await import(
  pathToFileURL(hostRequire.resolve('@matter/main').replace('/dist/cjs/', '/dist/esm/')).href
);
const storage = await mkdtemp(path.join(os.tmpdir(), 'zwave-matter-host-'));
Environment.default.vars.set('storage.path', storage);
const server = await ServerNode.create({ id: 'validation', network: { port: 0 } });
const { Service: S, Characteristic: C } = require('hap-nodejs');
const { MatterAccessories } = require('../dist/matter/MatterAccessories.js');
const manager = new AccessoryManager();
const platform = {
  Service: S,
  Characteristic: C,
  api: { matter: { deviceTypes } },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};
const bridge = new MatterAccessories(platform);
const categories = [
  ['Switch', [[C.On, true]]],
  ['Outlet', [[C.On, false]]],
  [
    'Lightbulb',
    [
      [C.On, true],
      [C.Brightness, 50],
    ],
  ],
  [
    'Lightbulb',
    [
      [C.On, true],
      [C.Brightness, 50],
      [C.Hue, 180],
      [C.Saturation, 50],
    ],
  ],
  ['LockMechanism', [[C.LockCurrentState, 1]]],
  ['MotionSensor', [[C.MotionDetected, true]]],
  ['ContactSensor', [[C.ContactSensorState, 0]]],
  ['LeakSensor', [[C.LeakDetected, 1]]],
  ['SmokeSensor', [[C.SmokeDetected, 1]]],
  ['CarbonMonoxideSensor', [[C.CarbonMonoxideDetected, 1]]],
  ['TemperatureSensor', [[C.CurrentTemperature, 21.5]]],
  ['HumiditySensor', [[C.CurrentRelativeHumidity, 45]]],
  ['LightSensor', [[C.CurrentAmbientLightLevel, 100]]],
  ['AirQualitySensor', [[C.AirQuality, 3]]],
  [
    'GarageDoorOpener',
    [
      [C.CurrentDoorState, 1],
      [C.TargetDoorState, 1],
    ],
  ],
  [
    'Fan',
    [
      [C.On, true],
      [C.RotationSpeed, 50],
    ],
  ],
  ['StatelessProgrammableSwitch', []],
  [
    'WindowCovering',
    [
      [C.CurrentPosition, 80],
      [C.TargetPosition, 60],
    ],
  ],
  [
    'Thermostat',
    [
      [C.CurrentTemperature, 21],
      [C.TargetHeatingCoolingState, 1],
      [C.TargetTemperature, 22],
      [C.HeatingThresholdTemperature, 20],
      [C.CoolingThresholdTemperature, 25],
    ],
  ],
];
function make(name, values, subtype = '0') {
  const service = new S[name]('Device', subtype);
  for (const [type, value] of values)
    service
      .getCharacteristic(type)
      .onGet(() => value)
      .updateValue(value);
  return service;
}
let checked = 0;
async function validate(descriptor) {
  const { deviceType } = await manager.prepareDeviceType(descriptor);
  for (const cluster of Object.keys(descriptor.clusters)) {
    assert(deviceType.behaviors[cluster], `${descriptor.displayName}: host dropped ${cluster}`);
  }
  const endpoint = new Endpoint(deviceType, { id: `check-${checked++}`, ...descriptor.clusters });
  await server.add(endpoint);
  for (const [cluster, attributes] of Object.entries(descriptor.clusters)) {
    for (const attribute of Object.keys(attributes)) {
      assert(attribute in endpoint.state[cluster], `${cluster}.${attribute} missing`);
      if (typeof attributes[attribute] === 'number' &&
          !(cluster === 'windowCovering' && attribute === 'targetPositionLiftPercent100ths')) {
        // The host's covering behavior seeds its target from current position during initialization.
        assert.equal(
          endpoint.state[cluster][attribute],
          attributes[attribute],
          `${cluster}.${attribute} changed during construction`,
        );
      }
    }
  }
  for (const part of descriptor.parts ?? []) {
    const prepared = await manager.prepareDeviceType(manager.partAsAccessory(part, part.id));
    const child = new Endpoint(prepared.deviceType, { id: part.id, ...part.clusters });
    await endpoint.add(child);
    for (const cluster of Object.keys(part.clusters)) {
      assert(child.state[cluster], `Child endpoint dropped ${cluster}`);
    }
    checked++;
  }
  await endpoint.close();
}
try {
  for (let n = 0; n < categories.length; n++) {
    const [name, values] = categories[n];
    const services = [
      make(name, values),
      make('Battery', [
        [C.BatteryLevel, 50],
        [C.StatusLowBattery, 0],
      ]),
    ];
    const accessory = {
      platformAccessory: {
        UUID: `host-${n}`,
        displayName: name,
        services,
        getService: (type) => services.find((s) => s.UUID === type.UUID),
      },
      node: {
        nodeId: 8,
        getDefinedValueIDs: () =>
          [1, 2].map((key) => ({
            commandClass: 67,
            endpoint: 0,
            property: 'setpoint',
            propertyKey: key,
          })),
      },
    };
    const descriptor = await bridge.describe(accessory, platform.api.matter);
    assert(descriptor, `${name} not described`);
    await validate(descriptor);
    // Homebridge restores device types by name and reconstructs empty handlers per cluster.
    const restoredType = Object.values(deviceTypes).find(
      (type) => type.name === descriptor.deviceType.name,
    );
    const restored = {
      ...descriptor,
      deviceType: restoredType,
      clusters: structuredClone(descriptor.clusters),
      handlers: Object.fromEntries(Object.keys(descriptor.clusters).map((key) => [key, {}])),
    };
    await validate(restored);
    console.log(`PASS ${name}: fresh and restored`);
  }
  const services = [
    make(
      'WindowCovering',
      [
        [C.CurrentPosition, 20],
        [C.TargetPosition, 40],
      ],
      '1',
    ),
    make(
      'WindowCovering',
      [
        [C.CurrentPosition, 80],
        [C.TargetPosition, 60],
      ],
      '2',
    ),
    make('TemperatureSensor', [[C.CurrentTemperature, 22]], '2'),
  ];
  const combined = {
    platformAccessory: {
      UUID: 'multi-covering',
      displayName: 'Combined node',
      services,
      getService: (type) => services.find((s) => s.UUID === type.UUID),
    },
    node: { nodeId: 9 },
  };
  const descriptor = await bridge.describe(combined, platform.api.matter);
  assert.equal(descriptor.parts.length, 2);
  await validate(descriptor);
  console.log('PASS composed device: two coverings and a temperature sensor');
} finally {
  bridge.stop();
  await server.close();
  await rm(storage, { recursive: true, force: true });
}
console.log(
  `Validated ${checked} endpoint constructions against Homebridge ${hostRequire('./package.json').version}`,
);
