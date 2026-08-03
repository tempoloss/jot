import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/commands.js";

test("plain text is a NOTE, not a task - no decision at capture time", () => {
  assert.deepEqual(parse("купить зарядку"), { kind: "note", title: "купить зарядку" });
});

test("space is trimmed", () => {
  assert.deepEqual(parse("  позвонить маме  "), { kind: "note", title: "позвонить маме" });
});

test("empty message does nothing", () => {
  assert.equal(parse("").kind, "empty");
  assert.equal(parse("   ").kind, "empty");
  assert.equal(parse(undefined).kind, "empty");
});

test("/t creates a task directly", () => {
  assert.deepEqual(parse("/t починить парсер"), { kind: "task_new", title: "починить парсер" });
  assert.equal(parse("/t").kind, "error");
});

test("/task promotes a note", () => {
  assert.deepEqual(parse("/task 5"), { kind: "promote", number: 5 });
  assert.deepEqual(parse("/task #5"), { kind: "promote", number: 5 });
  assert.equal(parse("/task").kind, "error");
  assert.equal(parse("/task abc").kind, "error");
});

test("/list and /notes are separate views", () => {
  assert.equal(parse("/list").kind, "list");
  assert.equal(parse("/notes").kind, "notes");
});

test("/start and /help both show help", () => {
  assert.equal(parse("/start").kind, "help");
  assert.equal(parse("/help").kind, "help");
});

test("group-style /list@botname is accepted", () => {
  assert.equal(parse("/list@tempo_projects_bot").kind, "list");
});

test("/done takes a number", () => {
  assert.deepEqual(parse("/done 3"), { kind: "done", number: 3 });
  assert.deepEqual(parse("/done #12"), { kind: "done", number: 12 });
});

test("/done rejects nonsense rather than saving it", () => {
  assert.equal(parse("/done").kind, "error");
  assert.equal(parse("/done abc").kind, "error");
  assert.equal(parse("/done 0").kind, "error");
  assert.equal(parse("/done -1").kind, "error");
});

test("/pic takes a number", () => {
  assert.deepEqual(parse("/pic 5"), { kind: "pic", number: 5 });
  assert.equal(parse("/pic").kind, "error");
});

test("/c splits number from body", () => {
  assert.deepEqual(parse("/c 3 продавец сказал завтра"),
    { kind: "comment", number: 3, body: "продавец сказал завтра" });
});

test("/c keeps the rest of the line intact including slashes", () => {
  assert.equal(parse("/c 3 см /list потом").body, "см /list потом");
});

test("/c without body or number is an error", () => {
  assert.equal(parse("/c 3").kind, "error");
  assert.equal(parse("/c 3   ").kind, "error");
  assert.equal(parse("/c abc text").kind, "error");
});

test("an unknown command is an error, never a silently saved note", () => {
  // Saving "/lsit" as a note would be worse than saying the command is unknown.
  const r = parse("/lsit");
  assert.equal(r.kind, "error");
  assert.match(r.message, /lsit/);
});

test("a slash mid-line is still a note", () => {
  assert.deepEqual(parse("купить 2/3 метра кабеля"),
    { kind: "note", title: "купить 2/3 метра кабеля" });
});

test("multiline text is kept whole", () => {
  const r = parse("купить зарядку\nи проверить порт");
  assert.equal(r.kind, "note");
  assert.match(r.title, /\n/);
});

test("text that looks like HTML is captured verbatim - escaping is the sink's job", () => {
  assert.equal(parse("a < b & c > d").title, "a < b & c > d");
});
