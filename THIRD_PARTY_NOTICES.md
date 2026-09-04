# MirrorSim third-party notices

MirrorSim release packages include a native AirPlay receiver built from the
public `Mahcks/AirPlayServer` fork. The exact source used for a release is the
AirPlayServer tag referenced by `receivers/runtime-manifest.json`. The
AirPlayServer repository's top-level MIT license does not replace the separate
licenses carried by third-party code compiled into the receiver runtime.

| Component | Shipped form | License / notice | Source |
| --- | --- | --- | --- |
| AirPlayServer wrapper code and MirrorSimAdapter | Portions of `airplay2dll.dll` and `MirrorSimAdapter.exe` | MIT; see `LICENSES/AirPlayServer-LICENSE` | https://github.com/Mahcks/AirPlayServer/tree/v0.5.0 |
| RAOP/AirPlay receiver core | Statically linked into `airplay2dll.dll` | GNU LGPL 2.1 or later; see `LICENSES/LGPL-2.1-or-later-LICENSE` and the notices in the tagged source files | https://github.com/Mahcks/AirPlayServer/tree/v0.5.0/AirPlayServerLib/lib |
| PlayFair implementation | Statically linked into `airplay2dll.dll` | GNU GPL 3.0; see `LICENSES/GPL-3.0-LICENSE` | https://github.com/Mahcks/AirPlayServer/tree/v0.5.0/AirPlayServerLib/lib/playfair |
| Vendored cryptographic and HTTP components | Statically linked into `airplay2dll.dll` | BSD-3-Clause, MIT, and zlib notices; see `LICENSES/AirPlayServer-vendored-NOTICES` | https://github.com/Mahcks/AirPlayServer/tree/v0.5.0/AirPlayServerLib/lib |
| mdns-sd 0.21.1 | Statically linked into the MirrorSim desktop app for built-in local-network discovery | MIT; see `LICENSES/mdns-sd-LICENSE` | https://github.com/keepsimple1/mdns-sd |
| FFmpeg 8.1.2 (`libavcodec`, `libavutil`, `libswscale`) | `avcodec-62.dll`, `avutil-60.dll`, `swscale-9.dll` | GNU LGPL 2.1 or later; the minimal shared build disables GPL, nonfree, and version-3 components and enables only the AAC and H.264 decoders plus required libraries. See `LICENSES/LGPL-2.1-or-later-LICENSE`. | https://github.com/Mahcks/AirPlayServer/releases/tag/v0.5.0 |
| libplist | Statically linked receiver dependency | GNU LGPL 2.1 or later; see `LICENSES/LGPL-2.1-or-later-LICENSE` | https://github.com/Mahcks/AirPlayServer/tree/v0.5.0/AirPlayServerLib/lib/plist |

The AirPlayServer v0.5.0 release attaches the exact FFmpeg 8.1.2 source archive,
its checksum, build configuration, and runtime provenance. The tagged receiver
source identifies other applicable copyright notices and licenses at file
level. This notice is an engineering inventory, not legal advice; distributors
should verify obligations and license compatibility for their distribution
channel and jurisdiction.
