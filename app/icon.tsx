import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 6,
          padding: 13,
          border: "2px solid #484848",
          borderRadius: 18,
          background: "linear-gradient(145deg, #181818, #080808)",
        }}
      >
        <span style={{ width: 7, height: 22, borderRadius: 8, background: "#c9c8c2" }} />
        <span style={{ width: 7, height: 38, borderRadius: 8, background: "#eeede7" }} />
        <span style={{ width: 7, height: 27, borderRadius: 8, background: "#c9c8c2" }} />
      </div>
    ),
    size,
  );
}
