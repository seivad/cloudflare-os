// Rules for the Skills library (`contextLibrary`) blueprint binding that are not about one
// workspace: what a user with no Skills account gets, and what a bound session says when Skills
// has been turned off.

import type { BlueprintBinding, BlueprintBindingAssignment } from "@gadgets/workshop-shared/api";

/**
 * Shown to a user with no Skills account. Skills is opt-in by default (the Connectors page) and an
 * admin can turn it off, so the one sentence names both ways out.
 */
export const NO_SKILLS_ACCOUNT =
    "You have no Skills library connected. Add Skills on the Connectors page, or ask an admin " +
    "to turn it on.";

/** Refused by every session of a Skills binding whose account is no longer provided. */
export const SKILLS_TURNED_OFF = "Skills is turned off for this account.";

/**
 * The binding names to leave out when instantiating a blueprint for a user: its Skills library
 * bindings, when the user has no Skills account and the blueprint marks them optional. Throws
 * NO_SKILLS_ACCOUNT when the user has none and one is not optional, so the caller refuses before it
 * creates anything.
 */
export function skillsBindingsLeftOut(
    assignments: Record<string, BlueprintBindingAssignment>,
    blueprintBindings: Record<string, BlueprintBinding>,
    hasSkillsAccount: boolean): Set<string> {
  let leftOut = new Set<string>();
  for (let [name, assignment] of Object.entries(assignments)) {
    if (assignment.type !== "contextLibrary") continue;
    let binding = Object.hasOwn(blueprintBindings, name) ? blueprintBindings[name] : undefined;
    if (binding?.type !== "contextLibrary") throw new Error(`Binding "${name}" type mismatch.`);
    if (hasSkillsAccount) continue;
    if (!binding.optional) throw new Error(NO_SKILLS_ACCOUNT);
    leftOut.add(name);
  }
  return leftOut;
}
