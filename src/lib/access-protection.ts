export function resolveAccessProtection({
  environment,
  user,
  password,
}: {
  environment?: string;
  user?: string;
  password?: string;
}): "enabled" | "disabled" | "misconfigured" {
  if (user?.trim() && password?.trim()) return "enabled";
  return environment === "production" ? "misconfigured" : "disabled";
}
