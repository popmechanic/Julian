import QRCode from "qrcode";

export async function generateQRSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    margin: 2,
    color: {
      dark: "#c4a0d4", // approximate oklch(77% 0.076 332) in hex
      light: "#00000000", // transparent background
    },
  });
}
