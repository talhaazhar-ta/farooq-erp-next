import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { SignInPage } from "./routes/sign-in";
import { AuthenticatedShell } from "./routes/shell";
import { DashboardPage } from "./routes/dashboard";

const rootRoute = createRootRoute();

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <AuthenticatedShell>
      <DashboardPage />
    </AuthenticatedShell>
  ),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});

const routeTree = rootRoute.addChildren([indexRoute, signInRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
