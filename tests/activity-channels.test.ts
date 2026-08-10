import { describe, expect, it } from "vitest";
import {
  CHANNEL_LABELS, HS_COMMUNICATION_CHANNELS, OTHER_CHANNELS, bucketOf,
  channelFromText, isOtherChannel, isOutreach, isSms,
} from "@/lib/activity-channels";

describe("channelFromText", () => {
  it("reads the channel a rep opened a HubSpot note with", () => {
    expect(channelFromText("LinkedIn: sent a connection request")).toBe("linkedin");
    expect(channelFromText("linkedin dm - followed up on the demo")).toBe("linkedin");
    expect(channelFromText("IG DM: asked about case volume")).toBe("instagram");
    expect(channelFromText("Instagram message: replied to their story")).toBe("instagram");
    expect(channelFromText("FB messenger - no reply yet")).toBe("facebook");
    expect(channelFromText("WhatsApp: shared the deck")).toBe("whatsapp");
    expect(channelFromText("SMS: sent the pricing sheet")).toBe("sms");
    expect(channelFromText("Texted - asked for a good time to call")).toBe("sms");
  });

  it("needs a separator, so ordinary prose is not a channel", () => {
    // Without this the agent's own notes and any summary mentioning a channel
    // would be miscounted as outreach on it.
    expect(channelFromText("Text me the deck when you get a chance")).toBeNull();
    expect(channelFromText("Sent an email with the case study")).toBeNull();
    expect(channelFromText("Called and left a voicemail about pricing")).toBeNull();
  });

  it("ignores the agent's auto-generated context notes", () => {
    expect(channelFromText("Lead context: inbound Meta ad, Plaintiff firm")).toBeNull();
    expect(channelFromText(null)).toBeNull();
    expect(channelFromText("")).toBeNull();
  });
});

describe("channel buckets", () => {
  it("keeps texting separate from the social bucket", () => {
    // Texts have Quo behind them and get their own series; social DMs are only
    // ever hand-logged and are reported together.
    expect(isSms("sms")).toBe(true);
    expect(isOtherChannel("sms")).toBe(false);
    for (const c of ["linkedin", "instagram", "facebook", "whatsapp", "other"]) {
      expect(isOtherChannel(c)).toBe(true);
      expect(isSms(c)).toBe(false);
    }
  });

  it("leaves calls, emails and meetings out of both buckets", () => {
    for (const t of ["call", "email", "voicemail", "in_person_visit", "demo", "note"]) {
      expect(isOtherChannel(t)).toBe(false);
      expect(isSms(t)).toBe(false);
    }
    expect(isOtherChannel(null)).toBe(false);
  });

  it("labels every channel it reports", () => {
    for (const c of [...OTHER_CHANNELS, "sms"]) {
      expect(CHANNEL_LABELS[c]).toBeTruthy();
    }
  });

  it("maps HubSpot's connected-channel names onto our vocabulary", () => {
    for (const v of Object.values(HS_COMMUNICATION_CHANNELS)) {
      expect(isSms(v) || isOtherChannel(v)).toBe(true);
    }
    expect(HS_COMMUNICATION_CHANNELS.LINKEDIN_MESSAGE).toBe("linkedin");
    expect(HS_COMMUNICATION_CHANNELS.SMS).toBe("sms");
  });
});

describe("bucketOf", () => {
  it("puts dials, emails and texts in their own bands", () => {
    expect(bucketOf("call")).toBe("calls");
    expect(bucketOf("voicemail")).toBe("calls");
    expect(bucketOf("email")).toBe("emails");
    expect(bucketOf("sms")).toBe("sms");
  });

  it("collects DMs, meetings and visits into one 'other' band", () => {
    for (const t of ["linkedin", "instagram", "facebook", "whatsapp", "other",
                     "meeting", "demo", "in_person_visit", "follow_up"]) {
      expect(bucketOf(t)).toBe("other");
    }
  });
});

describe("isOutreach", () => {
  it("counts a logged message on any channel", () => {
    expect(isOutreach("call", "call")).toBe(true);
    expect(isOutreach("meeting", null)).toBe(true);
    expect(isOutreach("communication", "linkedin")).toBe(true);
    expect(isOutreach("note", "instagram")).toBe(true);
  });

  it("rejects a bare note and every task", () => {
    // A note with no channel is the agent's own "Lead context:" note; a task is
    // a reminder to make contact, including one stamped with a type.
    expect(isOutreach("note", null)).toBe(false);
    expect(isOutreach("task", null)).toBe(false);
    expect(isOutreach("task", "walk_in")).toBe(false);
  });
});
