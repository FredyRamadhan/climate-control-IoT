"""Compile-time tests of the actual TX builder and RX decoder, without hardware.

Usage: python receive-node/tests/check_protocol.py --compiler <g++ executable>
Works with host g++ or the ESP8266 toolchain; produces no executable.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile


def function(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    rx = (root / 'receive-node/receive-node.ino').read_text(encoding='utf-8')
    tx = (root / 'transmit-node/transmit-node.ino').read_text(encoding='utf-8')
    definitions = re.findall(r'^#define (AC_IR_\w+)\s+(\S+)', rx, re.M)
    tx_definitions = dict(re.findall(r'^#define (AC_IR_\w+)\s+(\S+)', tx, re.M))
    assert dict(definitions) == tx_definitions, 'TX/RX constants differ'
    constants = '\n'.join(f'#define {key} {value}' for key, value in definitions)
    enum = re.search(r'enum FanSpeed[^}]+};', rx).group()
    builder = function(tx, 'uint32_t buildIrFrame()').replace(
        'uint32_t buildIrFrame()',
        'constexpr uint32_t buildIrFrame(bool relayOn, uint8_t targetTempC, FanSpeed fanSpeed)')
    decoder = 'constexpr ' + function(rx, 'bool decodeAcFrame(')
    # Only Serial is stubbed. Both protocol algorithms come from production code.
    program = '\n'.join(['#include <stdint.h>', constants, enum,
        'struct Log { constexpr void println(const char*) const {} };',
        'constexpr Log Serial{};', builder, decoder, r'''
constexpr bool reject(uint32_t frame) {
  bool power = true;
  uint8_t temp = 42;
  FanSpeed fan = FAN_MEDIUM;
  return !decodeAcFrame(frame, power, temp, fan) &&
         power && temp == 42 && fan == FAN_MEDIUM;
}
constexpr bool verify() {
  for (unsigned power = 0; power < 2; ++power)
    for (unsigned temp = 16; temp <= 30; ++temp)
      for (unsigned fan = 0; fan < 4; ++fan) {
        uint32_t frame = buildIrFrame(power, temp, (FanSpeed)fan);
        bool actualPower = false;
        uint8_t actualTemp = 0;
        FanSpeed actualFan = FAN_OFF;
        if (!decodeAcFrame(frame, actualPower, actualTemp, actualFan) ||
            actualPower != bool(power) || actualTemp != temp || actualFan != fan)
          return false;
        // Header, inverse byte, and each CRC bit must reject without mutation.
        for (unsigned bit = 24; bit < 32; ++bit)
          if (!reject(frame ^ (uint32_t(1) << bit))) return false;
        for (unsigned bit = 0; bit < 8; ++bit)
          if (!reject(frame ^ (uint32_t(1) << bit))) return false;
        for (unsigned bit = 18; bit < 23; ++bit)
          if (!reject(frame ^ (uint32_t(1) << bit))) return false;
      }
  // Invalid temperatures with otherwise correctly formed frames.
  return reject(buildIrFrame(true, 0, FAN_HIGH)) &&
         reject(buildIrFrame(true, 15, FAN_HIGH)) &&
         reject(buildIrFrame(true, 31, FAN_HIGH)) &&
         reject(buildIrFrame(true, 255, FAN_HIGH));
}
static_assert(verify(), "TX/RX roundtrip or corruption rejection failed");
'''])
    with tempfile.TemporaryDirectory(prefix='receiver-protocol-') as directory:
        path = Path(directory) / 'protocol.cpp'
        path.write_text(program, encoding='utf-8')
        subprocess.run([args.compiler, '-std=c++14', '-fsyntax-only', str(path)], check=True)
    print('PASS: 120 TX/RX states, 2520 corruptions, 4 invalid temperatures; rejection leaves outputs unchanged.')


if __name__ == '__main__':
    main()
