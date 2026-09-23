import { createContext, useContext, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Role } from "@farooq/shared";
import { api, ApiError, setCsrfToken } from "./api";

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: Role;
}

interface AuthContextValue {
  user: SessionUser | null | undefined; // undefined = loading
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginError: string | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loginError, setLoginError] = useState<string | null>(null);

  const meQuery = useQuery<SessionUser | null>({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        const user = await api.get<SessionUser>("/auth/me");
        // Re-hydrate the CSRF token after a reload — it lives only in
        // memory, never in a JS-readable cookie.
        const { csrfToken } = await api.get<{ csrfToken: string }>("/auth/csrf");
        setCsrfToken(csrfToken);
        return user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: async ({ username, password }: { username: string; password: string }) => {
      const result = await api.post<{ user: SessionUser; csrfToken: string }>("/auth/login", {
        username,
        password,
      });
      setCsrfToken(result.csrfToken);
      return result.user;
    },
    onSuccess: (user) => {
      setLoginError(null);
      queryClient.setQueryData(["auth", "me"], user);
    },
    onError: (err) => {
      setLoginError(err instanceof ApiError ? err.message : "Sign-in failed");
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => {
      setCsrfToken(null);
      queryClient.setQueryData(["auth", "me"], null);
    },
  });

  const value: AuthContextValue = {
    user: meQuery.isLoading ? undefined : (meQuery.data ?? null),
    isLoading: meQuery.isLoading,
    login: async (username, password) => {
      await loginMutation.mutateAsync({ username, password });
    },
    loginError,
    logout: async () => {
      await logoutMutation.mutateAsync();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
