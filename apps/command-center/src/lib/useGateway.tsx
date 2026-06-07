import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { GatewayClient, type ConnectionState } from "./client.js";
import type { BusEvent } from "./types.js";

interface GatewayContextValue {
  client: GatewayClient;
  state: ConnectionState;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

export function GatewayProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => new GatewayClient(), []);
  const [state, setState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const off = client.onState(setState);
    client.connect();
    return () => {
      off();
      client.stop();
    };
  }, [client]);

  return <GatewayContext.Provider value={{ client, state }}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway outside GatewayProvider");
  return ctx;
}

/** Subscribe to bus events matching a type prefix (or "*"). */
export function useBusEvents(prefix: string, handler: (event: BusEvent) => void): void {
  const { client } = useGateway();
  useEffect(
    () =>
      client.onEvent((event) => {
        if (prefix === "*" || event.type.startsWith(prefix)) handler(event);
      }),
    [client, prefix, handler],
  );
}

/** RPC poll: fetch on mount + reconnect + interval; refetch() for actions. */
export function useRpc<T>(
  method: string,
  params?: unknown,
  opts: { intervalMs?: number; enabled?: boolean } = {},
): { data: T | undefined; error: string | undefined; refetch: () => void } {
  const { client, state } = useGateway();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const paramsKey = JSON.stringify(params ?? null);

  useEffect(() => {
    if (state !== "open" || opts.enabled === false) return;
    let cancelled = false;
    const fetchOnce = () => {
      client.call<T>(method, params).then(
        (result) => {
          if (!cancelled) {
            setData(result);
            setError(undefined);
          }
        },
        (err: Error) => {
          if (!cancelled) setError(err.message);
        },
      );
    };
    fetchOnce();
    const timer = opts.intervalMs ? setInterval(fetchOnce, opts.intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, state, method, paramsKey, nonce, opts.intervalMs, opts.enabled]);

  return { data, error, refetch: () => setNonce((n) => n + 1) };
}
