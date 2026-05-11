import type { IconName } from "@/features/mirrorsim/types";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const p = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (name) {
    case "phone":
      return (
        <svg {...p}>
          <rect x="6" y="2" width="12" height="20" rx="2.5" />
          <path d="M10 17.5h4" />
        </svg>
      );
    case "camera":
      return (
        <svg {...p}>
          <path d="M4 9h3l1.4-2h7.2l1.4 2H20v10H4z" />
          <circle cx="12" cy="14" r="3" />
        </svg>
      );
    case "record":
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="3" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      );
    case "minimize":
      return (
        <svg {...p}>
          <path d="M6 18h12" />
        </svg>
      );
    case "maximize":
      return (
        <svg {...p}>
          <rect x="5" y="5" width="14" height="14" rx="1.5" />
        </svg>
      );
    case "close":
      return (
        <svg {...p}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      );
    case "fullscreen":
      return (
        <svg {...p}>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...p}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m21 21-4.5-4.5M10.5 7.5v6M7.5 10.5h6" />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...p}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m21 21-4.5-4.5M7.5 10.5h6" />
        </svg>
      );
    case "rotate":
      return (
        <svg {...p}>
          <path d="M16.5 7H20V3.5" />
          <path d="M19.5 7.5A8 8 0 1 0 20 12" />
        </svg>
      );
    case "settings":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      );
    case "reconnect":
      return (
        <svg {...p}>
          <path d="M2.5 4v5h5" />
          <path d="M2.5 9A9.5 9.5 0 0 1 12 2.5a9.5 9.5 0 0 1 9.5 9.5A9.5 9.5 0 0 1 12 21.5a9.5 9.5 0 0 1-6.5-2.5" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...p}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...p}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "compress":
      return (
        <svg {...p}>
          <path d="M14 10 21 3M21 3h-6M21 3v6M10 14 3 21M3 21h6M3 21v-6" />
        </svg>
      );
    case "console":
      return (
        <svg {...p}>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M7.5 10.5 10 13l-2.5 2.5M12.5 15.5h4" />
        </svg>
      );
  }
}