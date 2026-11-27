import { useEffect, useState } from "react";
import { getToken } from "../lib/api";

/** Loads an image from the API with the user's token (images are not public). */
export default function AuthImage({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { url = URL.createObjectURL(b); if (live) setSrc(url); })
      .catch(() => live && setFailed(true));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  if (failed) return <div className={`img-missing ${className ?? ""}`}>Image unavailable</div>;
  return src ? <img src={src} alt={alt} className={className} loading="lazy" /> : <div className={`skeleton ${className ?? ""}`} style={{ aspectRatio: "3 / 2", height: "auto" }} />;
}
