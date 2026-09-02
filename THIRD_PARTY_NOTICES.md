# MirrorSim third-party notices

MirrorSim release packages include a native AirPlay receiver derived from the
public `Mahcks/AirPlayServer` fork. The exact source used for a release is the
AirPlayServer tag referenced by `receivers/runtime-manifest.json`.

| Component | Shipped form | License / notice | Source |
| --- | --- | --- | --- |
| AirPlayServer and MirrorSimAdapter | `airplay2dll.dll`, `MirrorSimAdapter.exe` | MIT; see `LICENSES/AirPlayServer-LICENSE` | https://github.com/Mahcks/AirPlayServer |
| FFmpeg 4.2.2 (`libavcodec`, `libavutil`, `libswscale`) | `avcodec-58.dll`, `avutil-56.dll`, `swscale-5.dll` | The bundled binaries identify themselves as LGPL 2.1 or later and were configured as shared libraries with the H.264 decoder enabled. | https://github.com/FFmpeg/FFmpeg/tree/n4.2.2 |
| libplist | Statically linked receiver dependency | LGPL 2.1 or later | https://github.com/libimobiledevice/libplist |
| MSYS2 runtime 3.0.7 | `msys-2.0.dll` | GPL 3.0 or later; see the MSYS2 runtime source and COPYING file. | https://github.com/msys2/msys2-runtime |
| Fraunhofer FDK AAC Codec Library for Android 2.0.0 | Statically linked receiver dependency | Fraunhofer FDK AAC license; see `LICENSES/FDK-AAC-NOTICE` | https://github.com/Mahcks/AirPlayServer/tree/v0.3.0/AirPlayServerLib/lib/fdk-aac |

The FDK AAC license contains patent and source-availability conditions. The
corresponding source is available without charge in the tagged AirPlayServer
source repository. FFmpeg, libplist, and MSYS2 license texts and corresponding
source are available from the linked upstream repositories. This notice is an
engineering inventory, not legal advice; distributors should verify obligations
for their distribution channel and jurisdiction.
