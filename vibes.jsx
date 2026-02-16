      // Auto-generated vibes menu components
// Run: node scripts/build-components.js --force to regenerate
// Source: /Users/marcusestes/Websites/vibes-skill/components
// Generated: 2026-02-03T05:04:03.023Z
// Components: 25/25

// === useMobile ===
function useMobile() {
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);
  return isMobile;
}


// === useIsMobile === (alias for useMobile)
function useIsMobile() {
  return useMobile();
}


// === BackIcon ===
function BackIcon({
  bgFill = "#fff",
  fill = "#2a2a2a",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 44 44",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement("circle", { cx: "22", cy: "22", r: "22", fill: bgFill }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M13.5 22.95C13.5 23.25 13.605 23.504 13.82 23.711C14.035 23.918 14.301 24.02 14.613 24.02C14.918 24.02 15.172 23.918 15.387 23.711C15.602 23.504 15.711 23.25 15.711 22.95V11.7661L15.668 10.711L16.633 11.7661L17.641 12.797C17.828 12.996 18.086 13.094 18.414 13.094C18.699 13.094 18.941 13.008 19.133 12.828C19.328 12.649 19.422 12.414 19.422 12.129C19.422 11.985 19.395 11.856 19.336 11.742C19.281 11.629 19.195 11.516 19.078 11.399L15.387 7.81702C15.145 7.55902 14.879 7.43005 14.594 7.43005C14.309 7.43005 14.051 7.55902 13.82 7.81702L10.129 11.379C9.898 11.606 9.785 11.856 9.785 12.129C9.785 12.414 9.883 12.649 10.074 12.828C10.27 13.008 10.508 13.094 10.793 13.094C11.121 13.094 11.383 12.996 11.566 12.797L12.574 11.7661L13.543 10.711L13.5 11.7661V22.95ZM28.5 21.94V11.05C28.5 10.75 28.395 10.496 28.18 10.289C27.965 10.082 27.699 9.98 27.387 9.98C27.082 9.98 26.828 10.082 26.613 10.289C26.398 10.496 26.289 10.75 26.289 11.05V22.234L26.332 23.289L25.367 22.234L24.359 21.203C24.172 21.004 23.914 20.906 23.586 20.906C23.301 20.906 23.059 20.992 22.867 21.172C22.672 21.351 22.578 21.586 22.578 21.871C22.578 22.015 22.605 22.144 22.664 22.258C22.719 22.371 22.805 22.484 22.922 22.601L26.613 26.183C26.855 26.441 27.121 26.57 27.406 26.57C27.691 26.57 27.949 26.441 28.18 26.183L31.871 22.621C32.102 22.394 32.215 22.144 32.215 21.871C32.215 21.586 32.117 21.351 31.926 21.172C31.73 20.992 31.492 20.906 31.207 20.906C30.879 20.906 30.617 21.004 30.434 21.203L29.426 22.234L28.457 23.289L28.5 22.234V21.94Z",
        fill
      }
    )
  );
}


// === InviteIcon ===
function InviteIcon({
  bgFill = "#fff",
  fill = "#2a2a2a",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 44 44",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement("circle", { cx: "22", cy: "22", r: "22", fill: bgFill }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M21.894 24.02C22.199 24.02 22.453 23.918 22.668 23.711C22.883 23.504 22.992 23.25 22.992 22.95V11.7661L22.949 10.711L23.914 11.7661L24.922 12.797C25.109 12.996 25.367 13.094 25.695 13.094C25.98 13.094 26.222 13.008 26.414 12.828C26.609 12.649 26.703 12.414 26.703 12.129C26.703 11.985 26.676 11.856 26.617 11.742C26.562 11.629 26.476 11.516 26.359 11.399L22.668 7.81702C22.426 7.55902 22.16 7.43005 21.875 7.43005C21.59 7.43005 21.332 7.55902 21.101 7.81702L17.41 11.379C17.179 11.606 17.066 11.856 17.066 12.129C17.066 12.414 17.164 12.649 17.355 12.828C17.551 13.008 17.789 13.094 18.074 13.094C18.402 13.094 18.664 12.996 18.847 12.797L19.855 11.7661L20.824 10.711L20.781 11.7661V22.95C20.781 23.25 20.886 23.504 21.101 23.711C21.316 23.918 21.582 24.02 21.894 24.02ZM15.605 32.715H28.164C29.367 32.715 30.277 32.407 30.902 31.793C31.523 31.176 31.836 30.266 31.836 29.067V18.184C31.836 16.981 31.523 16.074 30.902 15.469C30.277 14.86 29.367 14.5551 28.164 14.5551H24.687V16.809H28.121C29.082 16.809 29.558 17.301 29.558 18.289V29C29.558 29.989 29.082 30.481 28.121 30.481H15.629C14.668 30.481 14.191 29.989 14.191 29V18.289C14.191 17.301 14.668 16.809 15.629 16.809H19.105V14.5551H15.605C14.418 14.5551 13.515 14.8641 12.89 15.4771C12.269 16.0941 11.957 16.996 11.957 18.184V29.067C11.957 30.266 12.269 31.176 12.89 31.793C13.515 32.407 14.418 32.715 15.605 32.715Z",
        fill
      }
    )
  );
}


// === LoginIcon ===
function LoginIcon({
  bgFill = "#fff",
  fill = "#2a2a2a",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 44 44",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement("circle", { cx: "22", cy: "22", r: "22", fill: bgFill }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M21.895 25.562C23.266 25.578 24.508 25.226 25.618 24.519C26.731 23.812 27.61 22.843 28.27 21.613C28.926 20.382 29.254 19 29.254 17.468C29.254 16.023 28.926 14.699 28.27 13.496C27.61 12.297 26.723 11.332 25.61 10.613C24.493 9.88604 23.254 9.52704 21.895 9.52704C20.52 9.52704 19.278 9.88604 18.161 10.613C17.043 11.332 16.157 12.297 15.5 13.496C14.84 14.699 14.516 16.023 14.532 17.468C14.532 19 14.86 20.375 15.512 21.589C16.157 22.804 17.039 23.769 18.149 24.476C19.258 25.183 20.508 25.547 21.895 25.562ZM21.895 40.519C23.524 40.519 25.145 40.304 26.758 39.867C28.368 39.429 29.875 38.8 31.297 37.976C32.711 37.156 33.969 36.164 35.075 35.007C34.301 33.777 33.243 32.726 31.911 31.863C30.571 30.996 29.047 30.336 27.336 29.886C25.625 29.433 23.809 29.207 21.895 29.207C19.946 29.207 18.114 29.441 16.399 29.894C14.68 30.355 13.164 31.015 11.836 31.882C10.516 32.75 9.46498 33.789 8.69598 35.007C9.79298 36.164 11.059 37.156 12.485 37.976C13.911 38.8 15.418 39.429 17.024 39.867C18.625 40.304 20.25 40.519 21.895 40.519Z",
        fill
      }
    )
  );
}


// === RemixIcon ===
function RemixIcon({
  bgFill = "#fff",
  fill = "#2a2a2a",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 44 44",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement("circle", { cx: "22", cy: "22", r: "22", fill: bgFill }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M28.442 19.879C29.145 19.879 29.762 19.594 30.301 19.032C30.836 18.465 31.106 17.739 31.106 16.8521C31.106 15.9501 30.84 15.2151 30.309 14.6411C29.781 14.0671 29.156 13.782 28.442 13.782C27.742 13.782 27.129 14.0671 26.606 14.6411C26.086 15.2151 25.824 15.9501 25.824 16.8521C25.824 17.739 26.09 18.465 26.617 19.032C27.149 19.594 27.754 19.879 28.442 19.879ZM21.895 32.95C23.426 32.95 24.774 32.672 25.942 32.114C27.109 31.555 28.012 30.918 28.656 30.203C29.301 29.489 29.621 28.887 29.621 28.399C29.621 28.129 29.516 27.942 29.301 27.844C29.086 27.742 28.863 27.742 28.637 27.844C27.836 28.285 26.91 28.711 25.867 29.121C24.82 29.528 23.496 29.731 21.895 29.731C20.277 29.731 18.949 29.524 17.914 29.11C16.875 28.692 15.949 28.27 15.133 27.844C14.902 27.742 14.684 27.742 14.469 27.844C14.254 27.942 14.145 28.129 14.145 28.399C14.145 28.887 14.473 29.489 15.121 30.203C15.774 30.918 16.68 31.555 17.84 32.114C18.996 32.672 20.352 32.95 21.895 32.95ZM15.328 19.879C16.027 19.879 16.649 19.594 17.184 19.032C17.719 18.465 17.988 17.739 17.988 16.8521C17.988 15.9501 17.723 15.2151 17.195 14.6411C16.664 14.0671 16.043 13.782 15.328 13.782C14.625 13.782 14.016 14.0671 13.504 14.6411C12.988 15.2151 12.731 15.9501 12.731 16.8521C12.731 17.739 12.992 18.465 13.512 19.032C14.035 19.594 14.641 19.879 15.328 19.879Z",
        fill
      }
    )
  );
}


// === SettingsIcon ===
function SettingsIcon({
  bgFill = "#fff",
  fill = "#2a2a2a",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 44 44",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement("circle", { cx: "22", cy: "22", r: "22", fill: bgFill }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M21.894 26.925C22.816 26.925 23.656 26.699 24.418 26.246C25.176 25.797 25.785 25.187 26.242 24.422C26.695 23.66 26.926 22.816 26.926 21.894C26.926 20.972 26.695 20.129 26.242 19.363C25.785 18.601 25.176 17.992 24.418 17.543C23.656 17.09 22.816 16.863 21.894 16.863C20.965 16.863 20.117 17.09 19.359 17.543C18.598 17.992 17.992 18.601 17.543 19.363C17.09 20.129 16.867 20.972 16.867 21.894C16.867 22.816 17.09 23.66 17.543 24.422C17.992 25.187 18.598 25.797 19.359 26.246C20.117 26.699 20.965 26.925 21.894 26.925ZM20.582 36.785C20.215 36.785 19.902 36.683 19.648 36.48C19.398 36.273 19.226 35.988 19.129 35.617L18.3911 32.48C18.1131 32.386 17.844 32.285 17.578 32.183C17.312 32.078 17.059 31.968 16.82 31.855L14.0861 33.535C13.7731 33.726 13.4531 33.804 13.1251 33.777C12.7971 33.75 12.5041 33.609 12.2501 33.351L10.426 31.527C10.168 31.269 10.023 30.972 9.992 30.629C9.957 30.285 10.043 29.965 10.254 29.66L11.9221 26.937C11.8051 26.691 11.6951 26.441 11.5941 26.183C11.4881 25.925 11.398 25.672 11.32 25.414L8.16003 24.66C7.78903 24.574 7.50405 24.406 7.30505 24.152C7.10505 23.902 7.00403 23.59 7.00403 23.218V20.64C7.00403 20.281 7.10505 19.972 7.30505 19.722C7.50405 19.468 7.78903 19.301 8.16003 19.215L11.293 18.461C11.379 18.164 11.4761 17.89 11.5861 17.633C11.6951 17.379 11.7971 17.136 11.8911 16.906L10.223 14.144C10.023 13.828 9.93706 13.511 9.96106 13.187C9.98406 12.867 10.129 12.5739 10.394 12.3199L12.2501 10.48C12.5041 10.222 12.789 10.078 13.101 10.039C13.418 10 13.73 10.078 14.043 10.269L16.809 11.976C17.043 11.855 17.301 11.738 17.57 11.629C17.84 11.519 18.1131 11.4179 18.3911 11.3199L19.129 8.172C19.226 7.812 19.398 7.52695 19.648 7.31995C19.902 7.10895 20.215 7.00397 20.582 7.00397H23.207C23.578 7.00397 23.8871 7.10895 24.1411 7.31995C24.3911 7.52695 24.559 7.812 24.644 8.172L25.387 11.351C25.68 11.445 25.9571 11.5429 26.2191 11.6479C26.4801 11.7539 26.726 11.867 26.953 11.992L29.746 10.269C30.051 10.078 30.3551 10.008 30.6641 10.054C30.9731 10.101 31.262 10.242 31.527 10.48L33.394 12.3199C33.66 12.5739 33.801 12.867 33.82 13.187C33.84 13.511 33.754 13.828 33.566 14.144L31.8831 16.906C31.9761 17.136 32.082 17.379 32.191 17.633C32.297 17.89 32.402 18.164 32.496 18.461L35.629 19.215C35.992 19.301 36.273 19.468 36.476 19.722C36.683 19.972 36.785 20.281 36.785 20.64V23.218C36.785 23.59 36.683 23.902 36.476 24.152C36.273 24.406 35.992 24.574 35.629 24.66L32.4691 25.414C32.3831 25.672 32.289 25.925 32.191 26.183C32.09 26.441 31.976 26.691 31.855 26.937L33.535 29.66C33.746 29.965 33.832 30.285 33.801 30.629C33.766 30.972 33.621 31.269 33.367 31.527L31.527 33.351C31.269 33.609 30.976 33.75 30.652 33.777C30.324 33.804 30.008 33.726 29.703 33.535L26.953 31.855C26.715 31.968 26.465 32.078 26.199 32.183C25.933 32.285 25.66 32.386 25.387 32.48L24.644 35.617C24.559 35.988 24.3911 36.273 24.1411 36.48C23.8871 36.683 23.578 36.785 23.207 36.785H20.582Z",
        fill
      }
    )
  );
}


// === GoogleIcon ===
function GoogleIcon({
  fill = "#000",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "10 10 24 24",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M32.5 22.2273C32.5 21.518 32.4386 20.8364 32.3239 20.1818H22V24.05H27.8977C27.65 25.3 26.9455 26.3591 25.8864 27.0682V29.5773H29.3182C31.2273 27.8364 32.5 25.2727 32.5 22.2273Z",
        fill
      }
    ),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M22 32C24.7 32 26.9636 31.1045 29.3182 29.5773L25.8864 27.0682C24.9909 27.6682 23.8636 28.0227 22 28.0227C19.3955 28.0227 17.1909 26.2636 16.4045 23.9H12.8636V26.4909C15.2091 31.1591 18.3409 32 22 32Z",
        fill
      }
    ),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M16.4045 23.9C16.1909 23.3 16.0682 22.6591 16.0682 22C16.0682 21.3409 16.1909 20.7 16.4045 20.1V17.5091H12.8636C12.1773 18.8727 11.8 20.3955 11.8 22C11.8 23.6045 12.1773 25.1273 12.8636 26.4909L16.4045 23.9Z",
        fill
      }
    ),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M22 15.9773C24.0227 15.9773 25.8409 16.6727 27.2727 18.0409L30.3364 14.9773C28.9591 13.6909 27.2045 12 22 12C18.3409 12 15.2091 12.8409 12.8636 17.5091L16.4045 20.1C17.1909 17.7364 19.3955 15.9773 22 15.9773Z",
        fill
      }
    )
  );
}


// === GitHubIcon ===
function GitHubIcon({
  fill = "#000",
  width = 44,
  height = 44
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "10 10 24 24",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement(
      "path",
      {
        fillRule: "evenodd",
        clipRule: "evenodd",
        d: "M22 11C15.925 11 11 15.925 11 22C11 26.8625 14.0375 31.0125 18.2625 32.4875C18.8125 32.5875 19.025 32.2625 19.025 31.9875C19.025 31.7375 19.0125 30.9125 19.0125 30.0375C16.5 30.5375 15.775 29.4625 15.55 28.9C15.425 28.6375 14.9 27.7 14.4375 27.45C14.0625 27.2625 13.5125 26.7625 14.425 26.75C15.275 26.7375 15.8875 27.525 16.1 27.85C17.05 29.4125 18.5875 28.9625 19.0625 28.6875C19.15 27.9625 19.4375 27.5 19.75 27.2375C17.4875 26.975 15.1 26.05 15.1 21.925C15.1 20.7375 15.425 19.7625 16.125 19.0125C16.025 18.75 15.65 17.65 16.225 16.2125C16.225 16.2125 17.1125 15.9375 19.025 17.2125C19.875 16.975 20.7875 16.8625 21.7 16.8625C22.6125 16.8625 23.525 16.975 24.375 17.2125C26.2875 15.925 27.175 16.2125 27.175 16.2125C27.75 17.65 27.375 18.75 27.275 19.0125C27.975 19.7625 28.3 20.725 28.3 21.925C28.3 26.0625 25.9 26.975 23.6375 27.2375C24.025 27.575 24.3625 28.225 24.3625 29.2375C24.3625 30.7 24.35 31.875 24.35 31.9875C24.35 32.2625 24.5625 32.6 25.1125 32.4875C29.3 31.0125 33 26.8625 33 22C33 15.925 28.075 11 22 11Z",
        fill
      }
    )
  );
}


// === MoonIcon ===
function MoonIcon({
  fill = "currentColor",
  width = 24,
  height = 24
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 24 24",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M21.752 15.002A9.718 9.718 0 0112.478 3.5a10.013 10.013 0 00-7.715 4.754A10.003 10.003 0 0012 22c3.516 0 6.63-1.817 8.426-4.564a9.724 9.724 0 01.326-.434z",
        fill
      }
    )
  );
}


// === SunIcon ===
function SunIcon({
  fill = "currentColor",
  width = 24,
  height = 24
}) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width,
      height,
      viewBox: "0 0 24 24",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
    /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "4", fill }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
        stroke: fill,
        strokeWidth: "2",
        strokeLinecap: "round"
      }
    )
  );
}


// === BrutalistCard.styles ===
function getShadowColor(variant) {
  switch (variant) {
    case "success":
      return "var(--vibes-green)";
    case "error":
      return "var(--vibes-red-accent)";
    case "warning":
      return "var(--vibes-yellow-accent)";
    case "default":
    default:
      return "var(--vibes-shadow-color)";
  }
}
function getPadding(size) {
  switch (size) {
    case "sm":
      return "0.75rem 1rem";
    case "md":
      return "1rem";
    case "lg":
      return "2rem 3rem";
    default:
      return "1rem";
  }
}
function getFontSize(size) {
  switch (size) {
    case "sm":
      return "0.875rem";
    case "md":
      return "1rem";
    case "lg":
      return "1rem";
    default:
      return "1rem";
  }
}
function getBoxShadow(size, variant) {
  const color = getShadowColor(variant);
  switch (size) {
    case "sm":
      return `2px 3px 0px 0px ${color}`;
    case "md":
      return `4px 5px 0px 0px ${color}`;
    case "lg":
      return `6px 6px 0px 0px ${color}`;
    default:
      return `4px 5px 0px 0px ${color}`;
  }
}
function getBorderRadius(messageType) {
  switch (messageType) {
    case "user":
      return "12px 12px 0 12px";
    case "ai":
      return "12px 12px 12px 0";
    default:
      return "12px";
  }
}
function getBrutalistCardStyle(variant = "default", size = "md", messageType) {
  return {
    borderRadius: getBorderRadius(messageType),
    padding: getPadding(size),
    fontSize: getFontSize(size),
    fontWeight: 500,
    letterSpacing: "0.02em",
    boxShadow: getBoxShadow(size, variant),
    transition: "box-shadow 0.15s ease, transform 0.15s ease",
    boxSizing: "border-box"
  };
}


// === BrutalistCard ===
const BrutalistCard = React.forwardRef(
  ({
    children,
    variant = "default",
    size = "md",
    messageType,
    style,
    className,
    ...divProps
  }, ref) => {
    const cardStyle = {
      ...getBrutalistCardStyle(variant, size, messageType),
      background: "var(--vibes-card-bg)",
      color: "var(--vibes-card-text)",
      border: "3px solid var(--vibes-card-border)",
      ...style
    };
    return /* @__PURE__ */ React.createElement("div", { ref, style: cardStyle, className, ...divProps }, children);
  }
);
BrutalistCard.displayName = "BrutalistCard";


// === LabelContainer.styles ===
function getLabelContainerContainerStyle() {
  return {
    position: "relative",
    display: "inline-flex",
    alignItems: "stretch",
    width: "auto",
    marginBottom: "40px"
  };
}
function getLabelContainerLabelStyle() {
  return {
    background: "var(--vibes-card-bg)",
    border: "2px solid var(--vibes-card-border)",
    borderLeft: "none",
    borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px",
    padding: "12px 8px",
    fontWeight: 700,
    fontSize: "14px",
    letterSpacing: "1px",
    whiteSpace: "nowrap",
    color: "var(--vibes-card-text)",
    writingMode: "vertical-rl",
    transform: "rotate(180deg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    margin: "32px 0px"
  };
}
function getLabelContainerButtonWrapperStyle() {
  return {
    background: "var(--vibes-card-bg)",
    border: "2px solid var(--vibes-card-border)",
    borderRadius: "8px",
    padding: "24px 24px 32px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "auto"
  };
}
function getLabelContainerResponsiveLabelStyle(isMobile, disappear = false) {
  if (isMobile) {
    if (disappear) {
      return {
        display: "none"
      };
    }
    return {
      background: "var(--vibes-card-bg)",
      border: "2px solid var(--vibes-card-border)",
      borderLeft: "2px solid var(--vibes-card-border)",
      borderBottom: "none",
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      borderBottomRightRadius: "0",
      padding: "8px 12px",
      fontWeight: 700,
      fontSize: "14px",
      letterSpacing: "1px",
      whiteSpace: "nowrap",
      color: "var(--vibes-card-text)",
      writingMode: "horizontal-tb",
      transform: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      width: "calc(100% - 64px)",
      margin: "0px 32px"
    };
  }
  return {
    background: "var(--vibes-card-bg)",
    border: "2px solid var(--vibes-card-border)",
    borderLeft: "none",
    borderBottom: "2px solid var(--vibes-card-border)",
    borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px",
    borderTopLeftRadius: "0",
    padding: "12px 8px",
    fontWeight: 700,
    fontSize: "14px",
    letterSpacing: "1px",
    whiteSpace: "nowrap",
    color: "var(--vibes-card-text)",
    writingMode: "vertical-rl",
    transform: "rotate(180deg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    margin: "32px 0px",
    width: "auto"
  };
}
function getLabelContainerResponsiveButtonWrapperStyle(isMobile, disappear = false) {
  if (isMobile && disappear) {
    return {
      background: "transparent",
      border: "none",
      borderRadius: "0",
      padding: "0",
      paddingBottom: "24px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "auto"
    };
  }
  if (isMobile && !disappear) {
    return {
      background: "var(--vibes-card-bg)",
      border: "2px solid var(--vibes-card-border)",
      borderRadius: "8px",
      padding: "24px 24px 32px 24px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "100%"
    };
  }
  return {
    background: "var(--vibes-card-bg)",
    border: "2px solid var(--vibes-card-border)",
    borderRadius: "8px",
    padding: "24px 24px 32px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "auto"
  };
}
function getLabelContainerResponsiveContainerStyle(isMobile) {
  if (isMobile) {
    return {
      position: "relative",
      display: "inline-flex",
      alignItems: "stretch",
      flexDirection: "column",
      width: "100%",
      marginBottom: "40px"
    };
  }
  return {
    position: "relative",
    display: "inline-flex",
    alignItems: "stretch",
    flexDirection: "row",
    width: "auto",
    marginBottom: "40px"
  };
}


// === LabelContainer ===
function LabelContainer({
  label,
  children,
  style,
  className,
  disappear = false
}) {
  const isMobile = useMobile();
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: { ...getLabelContainerResponsiveContainerStyle(isMobile), ...style },
      className
    },
    label && /* @__PURE__ */ React.createElement("div", { style: getLabelContainerResponsiveLabelStyle(isMobile, disappear) }, label),
    /* @__PURE__ */ React.createElement("div", { style: getLabelContainerResponsiveButtonWrapperStyle(isMobile, disappear) }, children)
  );
}


// === AuthScreen.styles ===
const getScreenContainerStyle = () => ({
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 1e3,
  overflow: "hidden"
});
const getOverlayStyle = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  zIndex: 0
});
const getBlackBorderWrapperStyle = () => ({
  position: "relative",
  width: "90%",
  maxWidth: "550px",
  backgroundImage: `
    linear-gradient(to right, rgba(0, 0, 0, 0.1) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(0, 0, 0, 0.1) 1px, transparent 1px)
  `,
  backgroundSize: "40px 40px",
  backgroundColor: "#e8e4df",
  border: "3px solid #1a1a1a",
  borderRadius: "12px",
  zIndex: 1,
  overflow: "hidden"
});
const getContainerStyle = () => ({
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  minHeight: "500px",
  width: "100%",
  gap: "2rem",
  padding: "3rem 0rem",
  position: "relative"
});
const getBackgroundStyle = (isShredding, isError) => ({
  position: "absolute",
  top: "1.5rem",
  left: "1.5rem",
  right: "1.5rem",
  bottom: "1.5rem",
  backgroundColor: isError ? "var(--vibes-red-accent, #ef4444)" : "var(--vibes-gray-lighter, #c4c4c4)",
  border: "1px solid black",
  borderRadius: "8px",
  zIndex: 0,
  transformOrigin: "center center",
  animation: isShredding ? "collapseToLine 1.2s ease-in-out forwards" : "none",
  pointerEvents: "none"
});
const getCardIconStyle = (isShredding) => ({
  marginBottom: "1rem",
  animation: isShredding ? "shredCard 0.9s ease-in forwards" : "none",
  position: "relative",
  zIndex: 1
});
const getAuthContentStyle = () => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: "1rem",
  width: "100%",
  maxWidth: "400px",
  padding: "0 1.5rem",
  position: "relative",
  zIndex: 1
});
const getTitleStyle = (isError) => ({
  fontSize: "1.75rem",
  fontWeight: "bold",
  color: isError ? "#991b1b" : "#1a1a1a",
  margin: 0,
  lineHeight: 1.2
});
const getMessageStyle = (isError) => ({
  fontSize: "1rem",
  color: isError ? "#7f1d1d" : "#555555",
  margin: 0,
  lineHeight: 1.5
});
const getErrorDetailsStyle = () => ({
  marginTop: "0.5rem",
  padding: "0.75rem",
  backgroundColor: "rgba(127, 29, 29, 0.1)",
  border: "1px solid rgba(127, 29, 29, 0.3)",
  borderRadius: "6px",
  fontSize: "0.75rem",
  color: "#7f1d1d",
  fontFamily: "monospace",
  maxWidth: "100%",
  overflow: "auto",
  textAlign: "left"
});
const getButtonsContainerStyle = () => ({
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  width: "100%",
  maxWidth: "400px",
  position: "relative",
  zIndex: 1
});
const getAnimationStyles = () => `
  @keyframes shredCard {
    0% {
      clip-path: inset(0 0 0% 0);
      transform: translateY(0);
    }
    45% {
      clip-path: inset(0 0 0% 0);
      transform: translateY(0);
    }
    80% {
      clip-path: inset(0 0 100% 0);
      transform: translateY(310px);
    }
    100% {
      clip-path: inset(0 0 100% 0);
      transform: translateY(310px);
    }
  }

  @keyframes collapseToLine {
    0% {
      transform: scale(1);
      border-radius: 8px;
      background-color: var(--vibes-gray-lighter, #c4c4c4);
    }
    40% {
      transform: scaleX(0.05) scaleY(0.01);
      border-radius: 50%;
      background-color: black;
    }
    45% {
      transform: scaleX(0.05) scaleY(0.01);
      border-radius: 50%;
      background-color: black;
    }
    65% {
      transform: scaleX(0.6) scaleY(0.01);
      border-radius: 0;
    }
    80% {
      transform: scaleX(0.6) scaleY(0.01);
      border-radius: 0;
    }
    100% {
      transform: scaleX(0) scaleY(0.01);
      border-radius: 0;
      background-color: black;
    }
  }
`;


// === AuthScreen ===
const CARD_URLS = [];
const AuthScreen = ({
  children,
  title,
  message,
  showCard = true,
  isShredding = false,
  isError = false,
  errorDetails
}) => {
  const [selectedCard, setSelectedCard] = React.useState(CARD_URLS[0]);
  const [cardLoaded, setCardLoaded] = React.useState(false);
  const [cardError, setCardError] = React.useState(false);
  React.useEffect(() => {
    const randomIndex = Math.floor(Math.random() * CARD_URLS.length);
    setSelectedCard(CARD_URLS[randomIndex]);
  }, []);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("style", null, getAnimationStyles()), /* @__PURE__ */ React.createElement("div", { style: getScreenContainerStyle() }, /* @__PURE__ */ React.createElement("div", { style: getOverlayStyle() }), /* @__PURE__ */ React.createElement("div", { style: getBlackBorderWrapperStyle() }, /* @__PURE__ */ React.createElement("div", { style: getBackgroundStyle(isShredding, isError) }), /* @__PURE__ */ React.createElement("div", { style: getContainerStyle() }, showCard && !cardError && /* @__PURE__ */ React.createElement("div", { style: getCardIconStyle(isShredding) }, /* @__PURE__ */ React.createElement(
    "img",
    {
      src: selectedCard,
      alt: "Vibes Card",
      style: {
        display: cardLoaded ? "block" : "none",
        width: "200px",
        height: "auto"
      },
      onLoad: () => setCardLoaded(true),
      onError: () => setCardError(true)
    }
  )), /* @__PURE__ */ React.createElement("div", { style: getAuthContentStyle() }, title && /* @__PURE__ */ React.createElement("h1", { style: getTitleStyle(isError) }, title), message && /* @__PURE__ */ React.createElement("p", { style: getMessageStyle(isError) }, message), errorDetails && /* @__PURE__ */ React.createElement("details", { style: { width: "100%" } }, /* @__PURE__ */ React.createElement("summary", { style: { cursor: "pointer", fontSize: "0.875rem", color: "#7f1d1d" } }, "Technical details"), /* @__PURE__ */ React.createElement("pre", { style: getErrorDetailsStyle() }, errorDetails))), /* @__PURE__ */ React.createElement("div", { style: getButtonsContainerStyle() }, children)))));
};


// === VibesButton.styles ===
const variantColors = {
  blue: "var(--vibes-variant-blue)",
  red: "var(--vibes-variant-red)",
  yellow: "var(--vibes-variant-yellow)",
  gray: "var(--vibes-variant-gray)"
};
function getVariantColor(variant) {
  return variantColors[variant] || variant;
}
const bounceKeyframes = `
  @keyframes vibes-button-bounce {
    0%, 100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-8px);
    }
  }
`;
function getFormButtonStyle(variant, formColor) {
  const cssColor = formColor || getVariantColor(variant);
  return {
    width: "100%",
    padding: "3px",
    backgroundColor: cssColor,
    border: "1px solid var(--vibes-button-border)",
    color: "var(--vibes-button-text)",
    fontSize: "24px",
    fontWeight: "bold",
    letterSpacing: "2px",
    cursor: "pointer",
    transition: "0.2s",
    borderRadius: "20px",
    textTransform: "none"
  };
}
function getButtonStyle(variant, isHovered, isActive, isMobile = false, hasIcon, buttonType, formColor) {
  if (buttonType === "form") {
    return getFormButtonStyle(variant, formColor);
  }
  const cssColor = getVariantColor(variant);
  let transform = "translate(0px, 0px)";
  let boxShadow = buttonType ? `7px 8px 0px 0px ${cssColor}, 7px 8px 0px 2px var(--vibes-button-border)` : `8px 10px 0px 0px ${cssColor}, 8px 10px 0px 2px var(--vibes-button-border)`;
  if (isHovered && !isActive) {
    transform = "translate(2px, 2px)";
    boxShadow = `2px 3px 0px 0px ${cssColor}, 2px 3px 0px 2px var(--vibes-button-border)`;
  }
  if (isActive) {
    transform = "translate(4px, 5px)";
    boxShadow = "none";
  }
  return {
    width: buttonType === "flat-rounded" ? "100%" : !hasIcon ? "auto" : isMobile ? "100%" : "130px",
    height: buttonType === "flat-rounded" ? "auto" : !hasIcon ? "auto" : isMobile ? "auto" : "135px",
    minHeight: isMobile ? "60px" : void 0,
    padding: buttonType === "flat-rounded" ? "0.5rem 0.75rem" : isMobile ? buttonType ? "none" : "0.75rem 1.5rem" : "1rem 2rem",
    borderRadius: "12px",
    fontSize: "1rem",
    fontWeight: 700,
    letterSpacing: "0.05em",
    cursor: "pointer",
    transition: "all 0.15s ease",
    position: "relative",
    transform,
    boxShadow
  };
}
function getMergedButtonStyle(baseStyle, ignoreDarkMode, customStyle, buttonType) {
  if (buttonType === "form") {
    return {
      ...baseStyle,
      ...customStyle
    };
  }
  const style = {
    ...baseStyle,
    background: ignoreDarkMode ? "var(--vibes-button-bg)" : "var(--vibes-button-bg-dark-aware)",
    color: ignoreDarkMode ? "var(--vibes-button-text)" : "var(--vibes-button-text-dark-aware)",
    border: ignoreDarkMode ? "2px solid var(--vibes-button-border)" : "2px solid var(--vibes-button-border-dark-aware)"
  };
  if (buttonType === "flat-rounded") {
    style.borderRadius = "50px";
  }
  return {
    ...style,
    ...customStyle
  };
}
function getIconContainerStyle(variant, isMobile, hasIcon, buttonType) {
  if (!hasIcon) return {};
  const cssColor = getVariantColor(variant);
  return {
    width: buttonType === "flat-rounded" ? "28px" : isMobile ? "48px" : "80px",
    height: buttonType === "flat-rounded" ? "28px" : isMobile ? "48px" : "80px",
    backgroundColor: buttonType === "flat-rounded" ? "transparent" : cssColor,
    borderRadius: buttonType === "flat-rounded" ? "0" : "8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    border: buttonType === "flat-rounded" ? "none" : "2px solid var(--vibes-black)"
  };
}
function getIconStyle(isMobile, isHovered, isActive) {
  return {
    width: isMobile ? "28px" : "50px",
    height: isMobile ? "28px" : "50px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    animation: isHovered && !isActive ? "vibes-button-bounce 0.8s ease-in-out infinite" : "none"
  };
}
function getVibesButtonContentWrapperStyle(isMobile, hasIcon, buttonType) {
  if (!hasIcon) return {};
  return {
    display: "flex",
    alignItems: "center",
    gap: buttonType === "flat-rounded" ? "0.5rem" : isMobile ? "16px" : "6px",
    flexDirection: buttonType === "flat-rounded" ? "row" : isMobile ? "row" : "column",
    justifyContent: buttonType === "flat-rounded" ? "flex-start" : isMobile ? "flex-start" : "center",
    width: "100%"
  };
}


// === VibesButton ===
const BLUE = "blue";
const RED = "red";
const YELLOW = "yellow";
const GRAY = "gray";
const iconMap = {
  login: LoginIcon,
  remix: RemixIcon,
  invite: InviteIcon,
  settings: SettingsIcon,
  back: BackIcon,
  google: GoogleIcon,
  github: GitHubIcon
};
function VibesButton({
  variant = "blue",
  buttonType = "square",
  children,
  onHover,
  onUnhover,
  icon,
  style: customStyle,
  className = "",
  ignoreDarkMode = false,
  formColor,
  ...props
}) {
  const buttonVariant = variant;
  const [isHovered, setHovered] = React.useState(false);
  const [isActive, setActive] = React.useState(false);
  const isMobile = useMobile();
  React.useEffect(() => {
    if (isHovered) {
      onHover?.();
    } else {
      onUnhover?.();
    }
  }, [isHovered, onHover, onUnhover]);
  const IconComponent = icon ? iconMap[icon] : void 0;
  const baseStyle = getButtonStyle(
    buttonVariant,
    isHovered,
    isActive,
    isMobile,
    !!IconComponent,
    buttonType,
    formColor
  );
  const mergedStyle = getMergedButtonStyle(
    baseStyle,
    ignoreDarkMode,
    customStyle,
    buttonType
  );
  const iconContainerStyle = getIconContainerStyle(
    buttonVariant,
    isMobile,
    !!IconComponent,
    buttonType
  );
  const iconStyle = getIconStyle(isMobile, isHovered, isActive);
  const contentWrapperStyle = getVibesButtonContentWrapperStyle(
    isMobile,
    !!IconComponent,
    buttonType
  );
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("style", null, bounceKeyframes), /* @__PURE__ */ React.createElement(
    "button",
    {
      ...props,
      className,
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => {
        setHovered(false);
        setActive(false);
      },
      onMouseDown: () => setActive(true),
      onMouseUp: () => setActive(false),
      style: mergedStyle
    },
    IconComponent ? /* @__PURE__ */ React.createElement("div", { style: contentWrapperStyle }, /* @__PURE__ */ React.createElement("div", { style: iconContainerStyle }, /* @__PURE__ */ React.createElement("div", { style: iconStyle }, /* @__PURE__ */ React.createElement(
      IconComponent,
      {
        bgFill: "var(--vibes-button-icon-bg)",
        fill: icon === "google" || icon === "github" ? "#000" : "var(--vibes-button-icon-fill)",
        width: buttonType === "flat-rounded" ? 28 : isMobile ? 28 : 45,
        height: buttonType === "flat-rounded" ? 28 : isMobile ? 28 : 45,
        withCircle: icon === "back"
      }
    ))), /* @__PURE__ */ React.createElement("span", null, children)) : children
  ));
}


// === Window Exports (for standalone apps) ===
// Expose key components to window for use in inline scripts
if (typeof window !== 'undefined') {
  // Hooks
  window.useMobile = useMobile;
  window.useIsMobile = useIsMobile;

  // Core components
  window.VibesButton = VibesButton;
  window.BrutalistCard = BrutalistCard;
  window.LabelContainer = LabelContainer;
  window.AuthScreen = AuthScreen;

  // Button variant constants
  window.BLUE = BLUE;
  window.RED = RED;
  window.YELLOW = YELLOW;
  window.GRAY = GRAY;

  // Icons
  window.BackIcon = BackIcon;
  window.InviteIcon = InviteIcon;
  window.LoginIcon = LoginIcon;
  window.RemixIcon = RemixIcon;
  window.SettingsIcon = SettingsIcon;
  window.GoogleIcon = GoogleIcon;
  window.GitHubIcon = GitHubIcon;
  window.MoonIcon = MoonIcon;
  window.SunIcon = SunIcon;
}
