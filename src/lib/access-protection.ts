export function resolveAccessProtection({
  environment,
  user,
  password,
  publicAccess,
}: {
  environment?: string;
  user?: string;
  password?: string;
  publicAccess?: string;
}): "enabled" | "disabled" | "misconfigured" {
  if (["1", "true"].includes(publicAccess?.trim().toLowerCase() ?? "")) return "disabled";
  if (user?.trim() && password?.trim()) return "enabled";
  return environment === "production" ? "misconfigured" : "disabled";
}
