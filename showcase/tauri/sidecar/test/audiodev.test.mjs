// Linux: the microphones and speakers for the Voice page (audiodev.mjs), from pactl's JSON (synthetic, in its shape
// on PipeWire). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceName, listDevices, parseDevices } from '../audiodev.mjs';

const SOURCES = JSON.stringify([
  { index: 37, name: 'effect_input.dsp.monitor', description: 'Monitor of Speaker DSP', monitor_of_sink: null },
  { index: 72, name: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic1__source', description: 'Digital Microphone' },
  { index: 90, name: 'alsa_input.usb-Codec-00.analog-stereo-input', description: 'USB Audio CODEC Analog Stereo' },
  { index: 91, name: 'odd name; rm -rf', description: 'Not a name the server writes' },
]);
const SINKS = JSON.stringify([
  { index: 71, name: 'alsa_output.pci-0000_00_1f.3.HiFi__Speaker__sink', description: 'Speaker' },
  { index: 80, name: 'bluez_output.00_11_22_33_44_55.1', description: '' },
]);

test('microphones are the sources that are not a monitor; speakers are the sinks; names only as the server writes them', () => {
  assert.deepEqual(parseDevices(SOURCES), [
    { name: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic1__source', label: 'Digital Microphone' },
    { name: 'alsa_input.usb-Codec-00.analog-stereo-input', label: 'USB Audio CODEC Analog Stereo' },
  ]);
  assert.deepEqual(parseDevices(SINKS).map((d) => d.label), ['Speaker', 'bluez_output.00_11_22_33_44_55.1'], 'no description: the name');
  assert.deepEqual(parseDevices(JSON.stringify([
    { name: 'a', description: '500 Series Chipset Family Audio (HD Audio) Speaker' },
    { name: 'b', description: '500 Series Chipset Family Audio (HD Audio) HDMI / DisplayPort 1 Output' },
    { name: 'd', description: '500 Series Chipset Family Audio (HD Audio) HDMI / DisplayPort 2 Output' },
    { name: 'c', description: 'PCM2902 Audio Codec Analog Stereo' },
  ])).map((d) => d.label), ['Speaker', 'HDMI / DisplayPort 1 Output', 'HDMI / DisplayPort 2 Output', 'PCM2902 Audio Codec Analog Stereo'], "a card's long shared name is left out, no more");
  assert.deepEqual(parseDevices('not json'), []);
  assert.deepEqual(parseDevices('{}'), []);
});

test('a pick is a device name or the default', () => {
  assert.equal(deviceName('alsa_input.usb-Codec-00.analog-stereo-input'), 'alsa_input.usb-Codec-00.analog-stereo-input');
  for (const bad of ['', 'a b', 'x;y', '$(id)', 7, null, 'x'.repeat(201)]) assert.equal(deviceName(bad), '', String(bad));
});

test('the list comes from pactl, or null with no sound server', async () => {
  const asked = [];
  const got = await listDevices(async (what) => { asked.push(what); return what === 'sources' ? SOURCES : SINKS; });
  assert.deepEqual(asked.sort(), ['sinks', 'sources']);
  assert.equal(got.mics.length, 2);
  assert.equal(got.speakers.length, 2);
  assert.equal(await listDevices(async () => null), null);
});
