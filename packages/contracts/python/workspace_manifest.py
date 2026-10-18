"""Pydantic mirror of workspace-manifest.schema.json."""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator


def _relative_workspace_path(value: str) -> str:
    if (
        not value
        or "\\" in value
        or PurePosixPath(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or PureWindowsPath(value).drive
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise ValueError("must be a normalized path relative to the workspace")
    return value


class WorkspaceManifestBackup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    source_path: str
    sidecar_path: str
    manifest_directory: str
    fingerprints_path: str
    decrypted_path: str
    results_path: str
    ileapp_output_path: str
    crash_reports_path: str
    report_path: str
    report_file_path: str
    run_summaries_path: str
    ileapp_log_path: str
    ileapp_modules_path: str

    @field_validator(
        "sidecar_path",
        "manifest_directory",
        "fingerprints_path",
        "decrypted_path",
        "results_path",
        "ileapp_output_path",
        "crash_reports_path",
        "report_path",
        "report_file_path",
        "run_summaries_path",
        "ileapp_log_path",
        "ileapp_modules_path",
    )
    @classmethod
    def validate_relative_paths(cls, value: str) -> str:
        return _relative_workspace_path(value)

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        if not value or value in (".", "..") or "/" in value or "\\" in value:
            raise ValueError("must be a plain backup label")
        return value

    @field_validator("source_path")
    @classmethod
    def validate_source_path(cls, value: str) -> str:
        if not value:
            raise ValueError("must not be empty")
        return value


class WorkspaceManifestSummaryFiles(BaseModel):
    model_config = ConfigDict(extra="forbid")

    processor_json_path: str
    processor_markdown_path: str

    @field_validator("processor_json_path", "processor_markdown_path")
    @classmethod
    def validate_relative_paths(cls, value: str) -> str:
        return _relative_workspace_path(value)


class WorkspaceManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    backups: list[WorkspaceManifestBackup]
    summary_files: WorkspaceManifestSummaryFiles
    # The folder each task's log is saved in (EPOCH-570).
    task_logs_path: str

    @field_validator("task_logs_path")
    @classmethod
    def validate_task_logs_path(cls, value: str) -> str:
        return _relative_workspace_path(value)

    @model_validator(mode="after")
    def labels_are_unique(self) -> WorkspaceManifest:
        labels = [backup.label for backup in self.backups]
        if len(labels) != len(set(labels)):
            raise ValueError("backup labels must be unique")
        return self


__all__ = ["WorkspaceManifest", "WorkspaceManifestBackup", "WorkspaceManifestSummaryFiles"]
