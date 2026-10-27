export function allowedTeamEmail(raw: unknown, email: string): boolean {
  if (typeof raw !== "string") return false;
  const emails = raw.split(",").map((value) => value.trim().toLowerCase());
  return emails.length <= 100 && emails.includes(email.toLowerCase()) && email.includes("@");
}
