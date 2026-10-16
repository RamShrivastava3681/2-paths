import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import api from "@/lib/api-client";

export type BusinessMode = "trading" | "manufacturer";

type BusinessModeState = {
  mode: BusinessMode;
  serverMode: "trading" | "manufacturer" | "both";
  loading: boolean;
  setMode: (m: BusinessMode) => void;
};

const Ctx = createContext<BusinessModeState | undefined>(undefined);

export const BUSINESS_MODE_LS_KEY = "whizunik-business-mode";

const LS_KEY = BUSINESS_MODE_LS_KEY;

function initialMode(): BusinessMode {
  try {
    const params = new URLSearchParams(window.location.search);
    // `?businessType=` is the canonical selector param (landing + auth);
    // `?mode=` is kept for backwards compatibility.
    const q = params.get("businessType") ?? params.get("mode");
    if (q === "trading" || q === "manufacturer") {
      window.localStorage.setItem(LS_KEY, q);
      return q;
    }
    const saved = window.localStorage.getItem(LS_KEY);
    if (saved === "trading" || saved === "manufacturer") return saved;
  } catch {
    /* ignore */
  }
  return "trading";
}

export function BusinessModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<BusinessMode>(() => initialMode());
  const [serverMode, setServerMode] = useState<"trading" | "manufacturer" | "both">("both");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ mode: "trading" | "manufacturer" | "both" }>("/business-mode")
      .then((d) => {
        if (cancelled) return;
        setServerMode(d.mode ?? "both");
        // If the tenant is locked to one mode, honour it.
        if (d.mode === "trading" || d.mode === "manufacturer") {
          setModeState(d.mode);
        }
      })
      .catch(() => {
        /* backend may be unreachable on public landing — stay local */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = (m: BusinessMode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(LS_KEY, m);
    } catch {
      /* ignore */
    }
  };

  return <Ctx.Provider value={{ mode, serverMode, loading, setMode }}>{children}</Ctx.Provider>;
}

export function useBusinessMode() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBusinessMode must be used within BusinessModeProvider");
  return v;
}
