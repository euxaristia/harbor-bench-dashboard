package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTailEventsOnlyAdvancesPastCompleteLines(t *testing.T) {
	trial := t.TempDir()
	agent := filepath.Join(trial, "agent")
	if err := os.Mkdir(agent, 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(agent, "events.txt")
	if err := os.WriteFile(logPath, []byte("{\"type\":\"text\",\"text\":\"one\"}\n{\"type\":"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := tailEvents(trial, 0)
	if got := len(result["events"].([]any)); got != 1 {
		t.Fatalf("events = %d, want 1", got)
	}
	offset := result["offset"].(int64)
	if err := os.WriteFile(logPath, []byte("{\"type\":\"text\",\"text\":\"one\"}\n{\"type\":\"text\",\"text\":\"two\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result = tailEvents(trial, offset)
	if got := len(result["events"].([]any)); got != 1 {
		t.Fatalf("events after append = %d, want 1", got)
	}
}

func TestSummarizeBuild(t *testing.T) {
	dir := t.TempDir()
	meta := object{"target": "linux-x86_64", "status": "running", "started_at": "2026-08-08T12:00:00Z"}
	data, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	log := "::phase::compiling release binary\n   Compiling serde v1\n   Checking cairn-code v1\n"
	if err := os.WriteFile(filepath.Join(dir, "build.log"), []byte(log), 0o644); err != nil {
		t.Fatal(err)
	}
	build := summarizeBuild(dir)
	if build.Phase != "compiling release binary" || build.CompiledUnits != 2 || build.CurrentUnit != "cairn-code" {
		t.Fatalf("unexpected build summary: %+v", build)
	}
}

func TestSafeChildRejectsTraversal(t *testing.T) {
	if _, ok := safeChild(t.TempDir(), ".."); ok {
		t.Fatal("accepted parent traversal")
	}
	if _, ok := safeChild(t.TempDir(), `a\\b`); ok {
		t.Fatal("accepted nested path")
	}
}
