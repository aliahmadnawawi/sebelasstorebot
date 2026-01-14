import QRCode from "qrcode";
export async function qrisToPngBuffer(qrString) {
  return QRCode.toBuffer(qrString, { type: "png", errorCorrectionLevel: "M", scale: 8 });
}
