# MirrorSim third-party notices

MirrorSim release packages include a native AirPlay receiver built from the
public `Mahcks/AirPlayServer` fork. The exact source used for a release is the
AirPlayServer tag referenced by `receivers/runtime-manifest.json`. The
AirPlayServer repository's top-level MIT license does not replace the separate
licenses carried by third-party code compiled into the receiver runtime.

| Component | Shipped form | License / notice | Source |
| --- | --- | --- | --- |
| AirPlayServer wrapper code and MirrorSimAdapter | Portions of `airplay2dll.dll` and `MirrorSimAdapter.exe` | MIT; see `LICENSES/AirPlayServer-LICENSE` | https://github.com/Mahcks/AirPlayServer/tree/v0.4.1 |
| RAOP/AirPlay receiver core | Statically linked into `airplay2dll.dll` | GNU LGPL 2.1 or later; see `LICENSES/LGPL-2.1-or-later-LICENSE` and the notices in the tagged source files | https://github.com/Mahcks/AirPlayServer/tree/v0.4.1/AirPlayServerLib/lib |
| PlayFair implementation | Statically linked into `airplay2dll.dll` | GNU GPL 3.0; see `LICENSES/GPL-3.0-LICENSE` | https://github.com/Mahcks/AirPlayServer/tree/v0.4.1/AirPlayServerLib/lib/playfair |
| Vendored cryptographic and HTTP components | Statically linked into `airplay2dll.dll` | BSD-3-Clause, MIT, and zlib notices; see `LICENSES/AirPlayServer-vendored-NOTICES` | https://github.com/Mahcks/AirPlayServer/tree/v0.4.1/AirPlayServerLib/lib |
| mdns-sd 0.21.1 | Statically linked into the MirrorSim desktop app for built-in local-network discovery | MIT; see `LICENSES/mdns-sd-LICENSE` | https://github.com/keepsimple1/mdns-sd |
| FFmpeg 4.2.2 (`libavcodec`, `libavutil`, `libswscale`) | `avcodec-58.dll`, `avutil-56.dll`, `swscale-5.dll` | The bundled binaries identify themselves as GNU LGPL 2.1 or later and were configured as shared libraries with the H.264 decoder enabled; see `LICENSES/LGPL-2.1-or-later-LICENSE`. | https://github.com/FFmpeg/FFmpeg/tree/n4.2.2 |
| libplist | Statically linked receiver dependency | GNU LGPL 2.1 or later; see `LICENSES/LGPL-2.1-or-later-LICENSE` | https://github.com/Mahcks/AirPlayServer/tree/v0.4.1/AirPlayServerLib/lib/plist |
| MSYS2 runtime 3.0.7 | `msys-2.0.dll` | The tagged source contains GPL, LGPL, and newlib license files; copies are included as `LICENSES/MSYS2-COPYING*`. | https://github.com/msys2/msys2-runtime/tree/msys2-3.0.7-6 |
| Fraunhofer FDK AAC Codec Library for Android 2.0.0 | Statically linked receiver dependency | Fraunhofer FDK AAC license; see `LICENSES/FDK-AAC-NOTICE` | https://github.com/Mahcks/AirPlayServer/tree/v0.4.1/AirPlayServerLib/lib/fdk-aac |

The FDK AAC license contains patent and source-availability conditions. The
corresponding source is available without charge in the tagged AirPlayServer
source repository. The tagged receiver source also identifies the applicable
copyright notices and licenses at file level. FFmpeg, libplist, PlayFair, and
MSYS2 source are available from the linked repositories. This notice is an
engineering inventory, not legal advice; distributors should verify obligations
and license compatibility for their distribution channel and jurisdiction.
