import { describe, expect, it } from "vitest";
import { isNoise, replyAfter } from "./useConversation";

describe("conversation mode", () => {
  it("never sends what Whisper makes of silence", () => {
    expect(isNoise("Thank you.")).toBe(true);
    expect(isNoise(" you ")).toBe(true);
    expect(isNoise("Thank you for booking it")).toBe(false);
  });

  it("speaks the agent's last message with text after what was sent", () => {
    const messages = [
      { sequence: 1, fromAgent: false, text: "Hi" },
      { sequence: 2, fromAgent: true, text: "Hello" },
      { sequence: 3, fromAgent: false, text: "Book it" },
      { sequence: 4, fromAgent: true, text: "Checking the calendar." },
      { sequence: 5, fromAgent: true, text: "" },
      { sequence: 6, fromAgent: true, text: "Booked for Thursday." },
    ];
    expect(replyAfter(messages, 3)?.text).toBe("Booked for Thursday.");
    expect(replyAfter(messages, 6)).toBeUndefined();
  });
});
