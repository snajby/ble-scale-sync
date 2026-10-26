import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { MqttConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const samplePayload: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const MEASURED_AT = new Date('2026-10-20T21:30:00Z');
// A literal, not MEASURED_AT.toISOString(), so the tests pin the format.
const MEASURED_AT_ISO = '2026-10-20T21:30:00.000Z';
const STATE_JSON = JSON.stringify({ timestamp: MEASURED_AT_ISO, ...samplePayload });

const BASE = 'scale/body-composition';

const defaultConfig: MqttConfig = {
  brokerUrl: 'mqtt://localhost:1883',
  topic: 'scale/body-composition',
  qos: 1,
  retain: true,
  clientId: 'ble-scale-sync',
  haDiscovery: false,
  haDeviceName: 'BLE Scale',
};

// The exporter uses `mqtt.connect()`, which returns the client synchronously
// and signals readiness with a 'connect' event, so the fake has to model that
// rather than resolve a ready client. See tests/helpers/fake-mqtt.ts.
const { fakeMqtt } = await vi.hoisted(async () => {
  const { createFakeMqtt } = await import('../helpers/fake-mqtt.js');
  return { fakeMqtt: createFakeMqtt() };
});

vi.mock('mqtt', () => ({
  connect: fakeMqtt.connect,
}));

/** The JSON body published to one topic. */
function published(topic: string): Record<string, unknown> {
  const call = fakeMqtt.publishAsync.mock.calls.find((c: unknown[]) => c[0] === topic);
  if (!call) throw new Error(`nothing published to ${topic}`);
  return JSON.parse(call[1] as string);
}

describe('MqttExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeMqtt.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "mqtt"', () => {
    const exporter = new MqttExporter(defaultConfig);
    expect(exporter.name).toBe('mqtt');
  });

  it('publishes payload as JSON to configured topic', async () => {
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload, { timestamp: MEASURED_AT });

    expect(result.success).toBe(true);
    expect(fakeMqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
      clientId: 'ble-scale-sync',
      username: undefined,
      password: undefined,
      connectTimeout: 10_000,
    });
    expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('scale/body-composition', STATE_JSON, {
      qos: 1,
      retain: true,
    });
    expect(fakeMqtt.endAsync).toHaveBeenCalled();
  });

  it('passes username and password when configured', async () => {
    const config: MqttConfig = {
      ...defaultConfig,
      username: 'user',
      password: 'pass',
    };
    const exporter = new MqttExporter(config);
    await exporter.export(samplePayload);

    expect(fakeMqtt.connect).toHaveBeenCalledWith(
      'mqtt://localhost:1883',
      expect.objectContaining({ username: 'user', password: 'pass' }),
    );
  });

  it('returns failure after retries when connect fails', async () => {
    fakeMqtt.setBehaviour({ kind: 'error', error: new Error('connection refused') });
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
    // 1 initial + 2 retries = 3 attempts
    expect(fakeMqtt.connect).toHaveBeenCalledTimes(3);
  });

  it('returns failure after retries when publish fails', async () => {
    fakeMqtt.publishAsync.mockRejectedValue(new Error('publish timeout'));
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('publish timeout');
    // Three messages per attempt, and the first rejection fails the attempt.
    expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(9);
  });

  it('always calls endAsync even if publish fails', async () => {
    fakeMqtt.publishAsync.mockRejectedValue(new Error('fail'));
    const exporter = new MqttExporter(defaultConfig);
    await exporter.export(samplePayload);

    // endAsync should have been called on each attempt
    expect(fakeMqtt.endAsync).toHaveBeenCalledTimes(3);
  });

  it('uses custom topic and qos', async () => {
    const config: MqttConfig = {
      ...defaultConfig,
      topic: 'home/weight',
      qos: 0,
      retain: false,
    };
    const exporter = new MqttExporter(config);
    await exporter.export(samplePayload);

    expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('home/weight', expect.any(String), {
      qos: 0,
      retain: false,
    });
  });

  // #497: JSON null is what HA's templates render as unknown.
  it('publishes a withheld value as null', async () => {
    const exporter = new MqttExporter(defaultConfig);
    await exporter.export({ ...samplePayload, bodyFatPercent: null, physiqueRating: null });

    const state = published(`${BASE}/composition`);
    expect(state.bodyFatPercent).toBeNull();
    expect(state.physiqueRating).toBeNull();
    expect(state.bmr).toBe(1750);
  });

  describe('measurement time (#478)', () => {
    it('publishes the measurement time from the context, not the time of the publish', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload, { timestamp: MEASURED_AT });

      for (const topic of [BASE, `${BASE}/weight`, `${BASE}/composition`]) {
        expect(published(topic).timestamp).toBe(MEASURED_AT_ISO);
      }
      const { timestamp, ...rest } = published(BASE);
      expect(timestamp).toBe(MEASURED_AT_ISO);
      expect(rest).toEqual(samplePayload);
    });

    it('falls back to the time of the export without a measurement time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MEASURED_AT);
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload);

      expect(published(`${BASE}/weight`).timestamp).toBe(MEASURED_AT_ISO);
    });

    it('sends the same timestamp on every retry of one export', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MEASURED_AT);
      // The first attempt fails seven seconds later; the retry must still send
      // the time the export started with, not the time it was retried at.
      fakeMqtt.publishAsync.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date('2026-10-20T21:30:07Z'));
        throw new Error('publish refused');
      });
      const exporter = new MqttExporter(defaultConfig);
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(true);
      expect(
        fakeMqtt.publishAsync.mock.calls.map(
          (c: unknown[]) => JSON.parse(c[1] as string).timestamp,
        ),
      ).toEqual(Array(6).fill(MEASURED_AT_ISO));
    });
  });

  describe('weight and composition messages', () => {
    const cfg: MqttConfig = { ...defaultConfig, haDiscovery: true };
    const withUser = { userSlug: 'filip', userName: 'Filip', timestamp: MEASURED_AT };

    it('publishes the weight and BMI on their own message', async () => {
      await new MqttExporter(cfg).export(samplePayload, withUser);
      expect(published(`${BASE}/filip/weight`)).toEqual({
        timestamp: MEASURED_AT_ISO,
        weight: 80,
        bmi: 23.9,
      });
    });

    it('publishes everything else on the composition message', async () => {
      await new MqttExporter(cfg).export(samplePayload, withUser);
      const { weight: _w, bmi: _b, ...rest } = samplePayload;
      expect(published(`${BASE}/filip/composition`)).toEqual({
        timestamp: MEASURED_AT_ISO,
        ...rest,
      });
    });

    it('still publishes the combined message on the base topic, as before', async () => {
      await new MqttExporter(cfg).export(samplePayload, withUser);
      expect(published(`${BASE}/filip`)).toEqual({ timestamp: MEASURED_AT_ISO, ...samplePayload });
    });

    it('publishes the weight message first, with the configured qos and retain', async () => {
      await new MqttExporter({ ...cfg, qos: 0, retain: false }).export(samplePayload, withUser);
      const data = fakeMqtt.publishAsync.mock.calls.filter(
        (c: unknown[]) =>
          !(c[0] as string).startsWith('homeassistant/') && !(c[0] as string).endsWith('/status'),
      );
      expect(data.map((c: unknown[]) => c[0])).toEqual([
        `${BASE}/filip/weight`,
        `${BASE}/filip/composition`,
        `${BASE}/filip`,
      ]);
      for (const c of data) expect(c[2]).toEqual({ qos: 0, retain: false });
    });

    it('points weight, BMI and the last weigh-in at the weight message, the rest at composition', async () => {
      await new MqttExporter(cfg).export(samplePayload, withUser);
      const state = (key: string) =>
        published(`homeassistant/sensor/ble-scale-sync-filip/${key}/config`).state_topic;
      expect(state('weight')).toBe(`${BASE}/filip/weight`);
      expect(state('bmi')).toBe(`${BASE}/filip/weight`);
      expect(state('timestamp')).toBe(`${BASE}/filip/weight`);
      expect(state('bodyFatPercent')).toBe(`${BASE}/filip/composition`);
      expect(state('impedance')).toBe(`${BASE}/filip/composition`);
      expect(state('metabolicAge')).toBe(`${BASE}/filip/composition`);
    });

    it('keeps the weight message complete when the composition is withheld', async () => {
      const bare = {
        ...samplePayload,
        bodyFatPercent: null,
        waterPercent: null,
        boneMass: null,
        muscleMass: null,
        visceralFat: null,
        physiqueRating: null,
      };
      await new MqttExporter(cfg).export(bare, withUser);
      expect(published(`${BASE}/filip/weight`)).toEqual({
        timestamp: MEASURED_AT_ISO,
        weight: 80,
        bmi: 23.9,
      });
      expect(published(`${BASE}/filip/composition`).bodyFatPercent).toBeNull();
    });
  });

  describe('Home Assistant discovery', () => {
    it('publishes discovery payloads + status + data when haDiscovery is true', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload, { timestamp: MEASURED_AT });

      // 12 discovery topics + 1 status publish + 3 data messages = 16 publishAsync calls
      expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(16);

      // First call should be a discovery config topic
      const firstCall = fakeMqtt.publishAsync.mock.calls[0];
      expect(firstCall[0]).toMatch(/^homeassistant\/sensor\/ble-scale-sync\//);
      expect(firstCall[2]).toEqual({ qos: 1, retain: true });

      // Second to last call should be the status publish
      const statusCall = fakeMqtt.publishAsync.mock.calls[12];
      expect(statusCall[0]).toBe('scale/body-composition/status');
      expect(statusCall[1]).toBe('online');

      // Then the weight, the composition and the combined message
      const dataTopics = fakeMqtt.publishAsync.mock.calls.slice(13).map((c: unknown[]) => c[0]);
      expect(dataTopics).toEqual([`${BASE}/weight`, `${BASE}/composition`, BASE]);
      expect(fakeMqtt.publishAsync.mock.calls[15][1]).toBe(STATE_JSON);
    });

    it('adds a Last Weigh-in timestamp sensor, the only one without a state class', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const configs = new Map(
        fakeMqtt.publishAsync.mock.calls
          .filter((c: unknown[]) => (c[0] as string).startsWith('homeassistant/'))
          .map((c: unknown[]) => [c[0] as string, JSON.parse(c[1] as string)]),
      );
      const timestampTopic = 'homeassistant/sensor/ble-scale-sync/timestamp/config';
      const sensor = configs.get(timestampTopic);
      expect(sensor).toBeDefined();
      expect(sensor).toMatchObject({
        name: 'Last Weigh-in',
        unique_id: 'ble-scale-sync_timestamp',
        state_topic: 'scale/body-composition/weight',
        value_template: '{{ value_json.timestamp }}',
        device_class: 'timestamp',
        availability: [{ topic: 'scale/body-composition/status' }],
        device: { identifiers: ['ble-scale-sync'] },
      });
      // HA rejects a unit and warns about a state class on a timestamp sensor.
      for (const key of [
        'state_class',
        'unit_of_measurement',
        'suggested_display_precision',
        'entity_category',
        'icon',
      ]) {
        expect(sensor).not.toHaveProperty(key);
      }

      // The exception is the timestamp sensor alone, and none of them forces
      // an update: a replayed retained message must not look like a weigh-in.
      for (const [topic, payload] of configs) {
        if (topic !== timestampTopic) expect(payload.state_class).toBe('measurement');
        expect(payload).not.toHaveProperty('force_update');
      }
    });

    it('sends correct discovery payload structure for weight', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      expect(weightCall).toBeDefined();

      const payload = JSON.parse(weightCall![1] as string);
      expect(payload).toMatchObject({
        name: 'Weight',
        unique_id: 'ble-scale-sync_weight',
        state_topic: 'scale/body-composition/weight',
        value_template: '{{ value_json.weight }}',
        state_class: 'measurement',
        unit_of_measurement: 'kg',
        device_class: 'weight',
        suggested_display_precision: 2,
        availability: [{ topic: 'scale/body-composition/status' }],
        device: {
          identifiers: ['ble-scale-sync'],
          name: 'BLE Scale',
          sw_version: expect.any(String),
        },
      });
    });

    it('uses configured topic as state_topic in discovery', async () => {
      const config: MqttConfig = {
        ...defaultConfig,
        topic: 'home/my-scale',
        haDiscovery: true,
      };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const bmiCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/bmi/config',
      );
      const payload = JSON.parse(bmiCall![1] as string);
      expect(payload.state_topic).toBe('home/my-scale/weight');
    });

    it('does not publish discovery when haDiscovery is false', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: false };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      // Only the three data messages, no discovery
      const topics = fakeMqtt.publishAsync.mock.calls.map((c: unknown[]) => c[0]);
      expect(topics).toEqual([`${BASE}/weight`, `${BASE}/composition`, BASE]);
    });

    it('shares device object across all discovery payloads', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const discoveryCalls = fakeMqtt.publishAsync.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).startsWith('homeassistant/'),
      );
      expect(discoveryCalls.length).toBe(12);

      const devices = discoveryCalls.map((c: unknown[]) => JSON.parse(c[1] as string).device);
      // All device objects should be identical
      for (const dev of devices) {
        expect(dev).toEqual(devices[0]);
      }
    });

    it('includes availability topic in discovery payloads', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const discoveryCalls = fakeMqtt.publishAsync.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).startsWith('homeassistant/'),
      );
      for (const call of discoveryCalls) {
        const payload = JSON.parse(call[1] as string);
        expect(payload.availability).toEqual([{ topic: 'scale/body-composition/status' }]);
      }
    });

    it('publishes online status after discovery', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      // Call index 12 (after 12 discovery payloads) should be the status publish
      const statusCall = fakeMqtt.publishAsync.mock.calls[12];
      expect(statusCall[0]).toBe('scale/body-composition/status');
      expect(statusCall[1]).toBe('online');
      expect(statusCall[2]).toEqual({ qos: 1, retain: true });
    });

    it('includes sw_version in device object', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.device.sw_version).toBeDefined();
      expect(typeof payload.device.sw_version).toBe('string');
    });

    it('sets precision 2 for weight and 1 for bmi', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightPayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
        )![1] as string,
      );
      expect(weightPayload.suggested_display_precision).toBe(2);

      const bmiPayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/bmi/config',
        )![1] as string,
      );
      expect(bmiPayload.suggested_display_precision).toBe(1);
    });

    it('does not set precision for impedance', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const impedancePayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/impedance/config',
        )![1] as string,
      );
      expect(impedancePayload.suggested_display_precision).toBeUndefined();
    });

    it('sets entity_category for impedance and physiqueRating', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const impedancePayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/impedance/config',
        )![1] as string,
      );
      expect(impedancePayload.entity_category).toBe('diagnostic');

      const physiquePayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/physiqueRating/config',
        )![1] as string,
      );
      expect(physiquePayload.entity_category).toBe('diagnostic');
    });

    it('does not set entity_category for weight', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightPayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
        )![1] as string,
      );
      expect(weightPayload.entity_category).toBeUndefined();
    });

    it('uses configurable haDeviceName', async () => {
      const config: MqttConfig = {
        ...defaultConfig,
        haDiscovery: true,
        haDeviceName: 'My Custom Scale',
      };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.device.name).toBe('My Custom Scale');
    });

    it('includes LWT in connect options when haDiscovery is true', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      expect(fakeMqtt.connect).toHaveBeenCalledWith(
        'mqtt://localhost:1883',
        expect.objectContaining({
          will: {
            topic: 'scale/body-composition/status',
            payload: Buffer.from('offline'),
            qos: 1,
            retain: true,
          },
        }),
      );
    });

    it('does not include LWT when haDiscovery is false', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: false };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const connectOpts = fakeMqtt.connect.mock.calls[0][1];
      expect(connectOpts.will).toBeUndefined();
    });

    describe('a metric only some weigh-ins carry (#497)', () => {
      const SKELETAL_TOPIC = 'homeassistant/sensor/ble-scale-sync/skeletalMusclePercent/config';

      function discovery(): Map<string, Record<string, unknown>> {
        return new Map(
          fakeMqtt.publishAsync.mock.calls
            .filter((c: unknown[]) => (c[0] as string).startsWith('homeassistant/'))
            .map((c: unknown[]) => [c[0] as string, JSON.parse(c[1] as string)]),
        );
      }

      function discoveryLog(spy: { mock: { calls: unknown[][] } }): string[] {
        return spy.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('Published HA discovery'));
      }

      it('publishes its sensor with a payload that has it: 13 configs, status, 3 messages', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const exporter = new MqttExporter({ ...defaultConfig, haDiscovery: true });
          const data = { ...samplePayload, skeletalMusclePercent: 47.8 };
          await exporter.export(data, { timestamp: MEASURED_AT });

          expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(17);
          const sensor = discovery().get(SKELETAL_TOPIC);
          expect(sensor).toEqual({
            name: 'Skeletal Muscle',
            unique_id: 'ble-scale-sync_skeletalMusclePercent',
            state_topic: 'scale/body-composition/composition',
            value_template:
              "{{ value_json.skeletalMusclePercent if value_json.skeletalMusclePercent is defined else 'None' }}",
            state_class: 'measurement',
            availability: [{ topic: 'scale/body-composition/status' }],
            device: expect.objectContaining({ identifiers: ['ble-scale-sync'] }),
            unit_of_measurement: '%',
            icon: 'mdi:arm-flex',
            suggested_display_precision: 1,
          });
          expect(published(`${BASE}/composition`).skeletalMusclePercent).toBe(47.8);
          expect(published(`${BASE}/weight`)).not.toHaveProperty('skeletalMusclePercent');
          expect(discoveryLog(log)).toEqual([
            expect.stringContaining('Published HA discovery for 13 sensors.'),
          ]);
        } finally {
          log.mockRestore();
        }
      });

      // Segment impedances are diagnostics: HA creates them disabled.
      it('publishes the ten segment impedances as disabled diagnostic sensors', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const exporter = new MqttExporter({ ...defaultConfig, haDiscovery: true });
          const segments = {
            impedanceTrunk20kHz: 22.2,
            impedanceTrunk100kHz: 17.4,
            impedanceLeftArm20kHz: 310.4,
            impedanceLeftArm100kHz: 275.3,
            impedanceRightArm20kHz: 305.5,
            impedanceRightArm100kHz: 270.4,
            impedanceLeftLeg20kHz: 227.6,
            impedanceLeftLeg100kHz: 201.7,
            impedanceRightLeg20kHz: 234.6,
            impedanceRightLeg100kHz: 208.5,
          };
          const data = { ...samplePayload, skeletalMusclePercent: 47.8, ...segments };
          await exporter.export(data, { timestamp: MEASURED_AT });

          // 12 + skeletal + 10 segments, status, 3 data messages.
          expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(27);
          const configs = discovery();
          expect(
            configs.get('homeassistant/sensor/ble-scale-sync/impedanceLeftArm100kHz/config'),
          ).toEqual({
            name: 'Impedance Left Arm 100 kHz',
            unique_id: 'ble-scale-sync_impedanceLeftArm100kHz',
            state_topic: 'scale/body-composition/composition',
            value_template:
              "{{ value_json.impedanceLeftArm100kHz if value_json.impedanceLeftArm100kHz is defined else 'None' }}",
            state_class: 'measurement',
            availability: [{ topic: 'scale/body-composition/status' }],
            device: expect.objectContaining({ identifiers: ['ble-scale-sync'] }),
            unit_of_measurement: 'Ω',
            icon: 'mdi:flash',
            suggested_display_precision: 1,
            entity_category: 'diagnostic',
            enabled_by_default: false,
          });
          const disabled = [...configs.entries()]
            .filter(([, c]) => c.enabled_by_default === false)
            .map(([t]) => t.split('/')[3]);
          expect(disabled.sort()).toEqual(Object.keys(segments).sort());
          expect(discoveryLog(log)).toEqual([
            expect.stringContaining('Published HA discovery for 23 sensors.'),
          ]);
        } finally {
          log.mockRestore();
        }
      });

      // A setup whose scale never measures it gets no entity at all, and the
      // twelve sensors every payload feeds keep their plain templates.
      it('publishes no sensor for it with a payload without it, and leaves the others as they were', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const exporter = new MqttExporter({ ...defaultConfig, haDiscovery: true });
          await exporter.export(samplePayload, { timestamp: MEASURED_AT });

          expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(16);
          const configs = discovery();
          expect(configs.has(SKELETAL_TOPIC)).toBe(false);
          expect([...configs.values()].map((c) => c.value_template).sort()).toEqual(
            [...Object.keys(samplePayload), 'timestamp'].map((k) => `{{ value_json.${k} }}`).sort(),
          );
          expect(discoveryLog(log)).toEqual([
            expect.stringContaining('Published HA discovery for 12 sensors.'),
          ]);
        } finally {
          log.mockRestore();
        }
      });
    });
  });
});
