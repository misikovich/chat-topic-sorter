export function messageVerify(message: string) {
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error("Message must be a non-blank string");
  }
}
