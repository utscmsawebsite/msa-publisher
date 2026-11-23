import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VolunteerStaffMember } from "../domain/volunteer.js";
import {
  buildStaffFormView,
  buildStaffView,
  staffRoles,
  type AdminViewContext,
} from "./volunteer-admin-views.js";
import { checkView, isObject, text } from "./volunteer-view-limits.testkit.js";

const member = (
  slackUserId: string,
  title: string | null,
  canApprove: boolean,
  canManage: boolean,
  isPrimary: boolean,
): VolunteerStaffMember => ({ slackUserId, displayName: null, title, canApprove, canManage, isPrimary });

const contextOf = (staff: VolunteerStaffMember[], canChangeStaff = true): AdminViewContext => ({
  data: { categories: [], events: [], staff, years: [], yearStats: [] },
  today: "2026-11-23",
  canChangeStaff,
});

type Option = { text: { text: string }; description?: { text: string }; value: string };
type Checkbox = { options: Option[]; initial_options?: Option[] };
type InputBlock = { type: string; label?: { text: string }; element?: Checkbox & { type?: string } };

const flagsInput = (view: { blocks?: unknown }): InputBlock => {
  const found = ((view.blocks ?? []) as InputBlock[]).find((block) => block.element?.type === "checkboxes");

  assert.ok(found, "the form has a role checkbox group");

  return found;
};

const sectionTexts = (view: { blocks?: unknown }): string[] =>
  ((view.blocks ?? []) as unknown[])
    .filter(isObject)
    .filter((block) => block.type === "section")
    .map((block) => text(block.text));

const contextTexts = (view: { blocks?: unknown }): string[] =>
  ((view.blocks ?? []) as unknown[])
    .filter(isObject)
    .filter((block) => block.type === "context")
    .flatMap((block) => ((block.elements ?? []) as unknown[]).map(text));

describe("the Add / Edit staff form", () => {
  it("asks for a Role, with Exec and Admin spelled out and what each one opens", () => {
    const input = flagsInput(buildStaffFormView(null, "staff"));
    const options = input.element?.options ?? [];

    assert.equal(input.label?.text, "Role (tick both if they do both)");
    assert.deepEqual(options.map((o) => o.text.text), ["Exec: approves hours", "Admin: manages setup", "Primary approver"]);
    assert.match(options[0]?.description?.text ?? "", /\/volunteer-exec/);
    assert.match(options[1]?.description?.text ?? "", /\/volunteer-admin/);
    assert.match(options[1]?.description?.text ?? "", /Doesn't include approving/);
    assert.match(options[2]?.description?.text ?? "", /Needs Exec too/);
  });

  it("keeps the saved values behind the boxes exactly as before, so nobody's access changes", () => {
    const options = flagsInput(buildStaffFormView(null, "staff")).element?.options ?? [];

    assert.deepEqual(options.map((o) => o.value), ["approve", "manage", "primary"]);
  });

  it("keeps every label and description inside Slack's 75-character limit", () => {
    for (const option of flagsInput(buildStaffFormView(null, "staff")).element?.options ?? []) {
      assert.ok(option.text.text.length <= 75, option.text.text);
      assert.ok((option.description?.text.length ?? 0) <= 75, option.description?.text ?? "");
    }
  });

  it("shows an existing person's roles ticked when editing", () => {
    const view = buildStaffFormView(member("U1", "VP", true, false, true), "staff");
    const ticked = flagsInput(view).element?.initial_options?.map((o) => o.value);

    assert.deepEqual(ticked, ["approve", "primary"]);
    assert.equal(flagsInput(buildStaffFormView(member("U2", null, false, true, false), "staff")).element?.initial_options?.map((o) => o.value).join(), "manage");
    assert.equal(flagsInput(buildStaffFormView(null, "staff")).element?.initial_options, undefined, "nothing is ticked for a new person");
  });

  it("no longer uses the old wording anywhere", () => {
    const json = JSON.stringify([buildStaffFormView(null, "staff"), buildStaffFormView(member("U1", null, true, true, true), "staff")]);

    for (const old of ["Can approve hours", "Can manage categories", "Permissions"]) {
      assert.ok(!json.includes(old), `still says "${old}"`);
    }
  });

  it("is a valid Slack screen, for a new person and for an edit", () => {
    for (const view of [buildStaffFormView(null, "staff"), buildStaffFormView(member("U1", "VP", true, true, true), "staff")]) {
      assert.deepEqual(checkView(view as never, "staff form", "modal"), []);
    }
  });
});

describe("the Staff list", () => {
  const staff = [
    member("UALL00001", "Director", true, true, true),
    member("UEXEC0002", "VP", true, false, false),
    member("UADMIN003", "Treasurer", false, true, false),
  ];

  it("names each person's roles in plain words", () => {
    const rows = sectionTexts(buildStaffView(contextOf(staff))).join("\n");

    assert.ok(rows.includes("Exec · Admin · Primary approver"));
    assert.ok(rows.includes("Treasurer\nAdmin"));
    assert.ok(rows.includes("VP\nExec"));
    for (const old of ["approve, manage", "primary\n"]) {
      assert.ok(!rows.includes(old), `still says "${old}"`);
    }
  });

  it("explains Exec, Admin and the settings-named admins in one line", () => {
    for (const canChangeStaff of [true, false]) {
      const key = contextTexts(buildStaffView(contextOf(staff, canChangeStaff))).join("\n");

      assert.ok(key.includes("*Exec* approves hours and opens /volunteer-exec"), key);
      assert.ok(key.includes("*Admin* manages setup and opens /volunteer-admin"), key);
      assert.ok(key.includes("Admins named in Vercel can also change staff and aren't listed here"), key);
    }
  });

  it("still only lets settings-named admins change staff", () => {
    const withEdit = JSON.stringify(buildStaffView(contextOf(staff, true)));
    const without = JSON.stringify(buildStaffView(contextOf(staff, false)));

    assert.ok(withEdit.includes("add:staff") && withEdit.includes("edit:staff:UALL00001"));
    assert.ok(!without.includes("add:staff") && !without.includes("edit:staff:"));
    assert.ok(without.includes("Only the volunteer admins named in the bot's settings can change who is staff."));
  });

  it("is a valid Slack screen, also when it is empty or full", () => {
    const many = Array.from({ length: 60 }, (_, index) => member(`UMANY${String(index).padStart(5, "0")}`, "Title", index % 2 === 0, true, false));

    for (const list of [[], staff, many]) {
      assert.deepEqual(checkView(buildStaffView(contextOf(list)) as never, "staff list", "modal"), []);
    }
  });

  it("describes every combination", () => {
    assert.equal(staffRoles(member("U", null, true, false, false)), "Exec");
    assert.equal(staffRoles(member("U", null, false, true, false)), "Admin");
    assert.equal(staffRoles(member("U", null, true, true, false)), "Exec · Admin");
    assert.equal(staffRoles(member("U", null, true, true, true)), "Exec · Admin · Primary approver");
    assert.equal(staffRoles(member("U", null, false, false, false)), "No role");
  });
});
