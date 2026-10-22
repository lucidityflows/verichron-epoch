// The iPhone libraries' pins, from the one place they are declared (the app's
// guided setup, EPOCH-465), as lines for tools/iphone/build.sh:
//   name|version|url|sha256|configure arguments
import { PINNED_COMPONENTS, archiveName } from '../../apps/epoch/src/main/tools/device-backup/ios/toolchain/pins';

for (const pin of PINNED_COMPONENTS) {
  console.log([pin.name, pin.version, pin.url, pin.sha256, archiveName(pin), pin.configureArgs.join(' ')].join('|'));
}
