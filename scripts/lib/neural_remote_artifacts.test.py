#!/usr/bin/env python3
"""Executable contract tests for closed neural remote archives."""

from __future__ import annotations

import gzip
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from neural_remote_artifacts import (
    ArchiveFile,
    BIGRU_ATTENTION_CONFIG,
    BUNDLE_KIND,
    CTC_TRANSFORMER_CONFIG,
    CTC_TRANSFORMER_SHARED_MODEL,
    CTC_TRANSFORMER_TRAINER,
    NeuralRemoteArtifactError,
    SEQ2SEQ_TRAINER,
    build_closed_archive,
    collect_training_bundle,
    manifest_identity,
    regular_tar_info,
    sha256_file,
    trainer_path_for_config,
    validate_closed_manifest,
    verify_closed_archive,
    verify_extracted_tree,
)


ROOT = Path(__file__).resolve().parents[2]


class NeuralRemoteArtifactTests(unittest.TestCase):
    def test_closed_archive_is_deterministic_verified_and_atomic(self) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-archive-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "alpha.txt").write_text("alpha\n", encoding="utf-8")
            (source / "nested").mkdir()
            (source / "nested/beta.json").write_text(
                json.dumps({"beta": "नेपाली"}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            files = [
                ArchiveFile(
                    source=source / "alpha.txt",
                    archive_path="alpha.txt",
                    role="alpha",
                ),
                ArchiveFile(
                    source=source / "nested/beta.json",
                    archive_path="nested/beta.json",
                    role="beta",
                ),
            ]
            first = build_closed_archive(
                source_root=source,
                output_dir=root / "first",
                artifact_kind=BUNDLE_KIND,
                filename_stem="fixture",
                manifest_base={
                    "schemaVersion": 1,
                    "modelId": "fixture-model",
                },
                files=files,
            )
            second = build_closed_archive(
                source_root=source,
                output_dir=root / "second",
                artifact_kind=BUNDLE_KIND,
                filename_stem="fixture",
                manifest_base={
                    "schemaVersion": 1,
                    "modelId": "fixture-model",
                },
                files=files,
            )
            self.assertEqual(first["bundleId"], second["bundleId"])
            self.assertEqual(first["archiveSha256"], second["archiveSha256"])

            extracted = root / "extracted"
            verified = verify_closed_archive(
                Path(first["archive"]),
                expected_kind=BUNDLE_KIND,
                expected_archive_sha256=first["archiveSha256"],
                extract_to=extracted,
            )
            self.assertEqual(verified["bundleId"], first["bundleId"])
            self.assertEqual(
                (extracted / "alpha.txt").read_text(encoding="utf-8"),
                "alpha\n",
            )
            self.assertEqual(
                verify_extracted_tree(
                    extracted,
                    expected_kind=BUNDLE_KIND,
                )["bundleId"],
                first["bundleId"],
            )
            (extracted / "unlisted.txt").write_text(
                "unexpected",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "unlisted",
            ):
                verify_extracted_tree(
                    extracted,
                    expected_kind=BUNDLE_KIND,
                )

    def test_outer_digest_and_declared_source_digest_fail_closed(self) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-digest-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            source = root / "source.txt"
            source.write_text("payload\n", encoding="utf-8")
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "digest is stale",
            ):
                build_closed_archive(
                    source_root=root,
                    output_dir=root / "bad",
                    artifact_kind=BUNDLE_KIND,
                    filename_stem="bad",
                    manifest_base={"schemaVersion": 1},
                    files=[
                        ArchiveFile(
                            source=source,
                            archive_path="source.txt",
                            role="fixture",
                            expected_sha256="0" * 64,
                        )
                    ],
                )
            report = build_closed_archive(
                source_root=root,
                output_dir=root / "good",
                artifact_kind=BUNDLE_KIND,
                filename_stem="good",
                manifest_base={"schemaVersion": 1},
                files=[
                    ArchiveFile(
                        source=source,
                        archive_path="source.txt",
                        role="fixture",
                        expected_sha256=sha256_file(source),
                    )
                ],
            )
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "trusted value",
            ):
                verify_closed_archive(
                    Path(report["archive"]),
                    expected_kind=BUNDLE_KIND,
                    expected_archive_sha256="f" * 64,
                )

    def test_path_traversal_and_symbolic_link_members_are_rejected(self) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-malicious-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            traversal = root / "traversal.tar.gz"
            write_malicious_archive(
                traversal,
                name="lekh-neural-remote/../escape.txt",
                symbolic_link=False,
            )
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "escapes",
            ):
                verify_closed_archive(
                    traversal,
                    expected_kind=BUNDLE_KIND,
                )

            symbolic = root / "symbolic.tar.gz"
            write_malicious_archive(
                symbolic,
                name="lekh-neural-remote/link",
                symbolic_link=True,
            )
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "metadata is unsafe",
            ):
                verify_closed_archive(
                    symbolic,
                    expected_kind=BUNDLE_KIND,
                )

    def test_symbolic_link_inputs_roots_and_archive_aliases_are_rejected(
        self,
    ) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-symlink-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            source_root = root / "source"
            source_root.mkdir()
            source = source_root / "payload.txt"
            source.write_text("payload\n", encoding="utf-8")
            source_alias = source_root / "payload-alias.txt"
            source_alias.symlink_to(source)
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "symbolic link",
            ):
                build_closed_archive(
                    source_root=source_root,
                    output_dir=root / "rejected-source",
                    artifact_kind=BUNDLE_KIND,
                    filename_stem="fixture",
                    manifest_base={"schemaVersion": 1},
                    files=[
                        ArchiveFile(
                            source=source_alias,
                            archive_path="payload.txt",
                            role="fixture",
                        )
                    ],
                )

            report = build_closed_archive(
                source_root=source_root,
                output_dir=root / "valid",
                artifact_kind=BUNDLE_KIND,
                filename_stem="fixture",
                manifest_base={"schemaVersion": 1},
                files=[
                    ArchiveFile(
                        source=source,
                        archive_path="payload.txt",
                        role="fixture",
                    )
                ],
            )
            archive_alias = root / "archive-alias.tar.gz"
            archive_alias.symlink_to(Path(report["archive"]))
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "unsafe",
            ):
                verify_closed_archive(
                    archive_alias,
                    expected_kind=BUNDLE_KIND,
                )

            extracted = root / "extracted"
            verify_closed_archive(
                Path(report["archive"]),
                expected_kind=BUNDLE_KIND,
                extract_to=extracted,
            )
            extracted_alias = root / "extracted-alias"
            extracted_alias.symlink_to(extracted, target_is_directory=True)
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "root is unsafe",
            ):
                verify_extracted_tree(
                    extracted_alias,
                    expected_kind=BUNDLE_KIND,
                )

    def test_reserved_names_and_malformed_manifest_entries_fail_closed(
        self,
    ) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-schema-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            source = root / "source.txt"
            source.write_text("payload\n", encoding="utf-8")
            with self.assertRaisesRegex(
                NeuralRemoteArtifactError,
                "filename component",
            ):
                build_closed_archive(
                    source_root=root,
                    output_dir=root / "output",
                    artifact_kind=BUNDLE_KIND,
                    filename_stem="../escape",
                    manifest_base={"schemaVersion": 1},
                    files=[
                        ArchiveFile(
                            source=source,
                            archive_path="source.txt",
                            role="fixture",
                        )
                    ],
                )

        malformed = {
            "schemaVersion": 1,
            "artifactKind": BUNDLE_KIND,
            "archivePrefix": "lekh-neural-remote",
            "compression": "tar-gzip-deterministic-v1",
            "files": ["not-an-object"],
        }
        malformed["bundleId"] = manifest_identity(
            malformed,
            "bundleId",
        )
        with self.assertRaisesRegex(
            NeuralRemoteArtifactError,
            "entry schema",
        ):
            validate_closed_manifest(
                malformed,
                expected_kind=BUNDLE_KIND,
                observed=[],
            )

    def test_canonical_training_bundle_inventory_is_complete(self) -> None:
        manifest, files = collect_training_bundle(
            ROOT,
            BIGRU_ATTENTION_CONFIG,
        )
        paths = {item.archive_path for item in files}
        self.assertEqual(manifest["modelId"], "lekh-open-vocab-bigru-attention-v1")
        self.assertEqual(manifest["trainerPath"], SEQ2SEQ_TRAINER)
        self.assertEqual(
            trainer_path_for_config(BIGRU_ATTENTION_CONFIG),
            SEQ2SEQ_TRAINER,
        )
        self.assertEqual(len(files), 24)
        self.assertIn("data/generated/neural-open-vocab/train.jsonl", paths)
        self.assertIn("scripts/run-neural-remote-training.py", paths)
        self.assertIn("requirements/neural-open-vocab.lock", paths)
        self.assertIn(
            "requirements/neural-open-vocab-cu118.lock",
            paths,
        )

        ctc_manifest, ctc_files = collect_training_bundle(
            ROOT,
            CTC_TRANSFORMER_CONFIG,
        )
        ctc_paths = {item.archive_path for item in ctc_files}
        self.assertEqual(
            ctc_manifest["modelId"],
            "lekh-open-vocab-ctc-transformer-v2",
        )
        self.assertEqual(
            ctc_manifest["trainerPath"],
            CTC_TRANSFORMER_TRAINER,
        )
        self.assertEqual(len(ctc_files), 26)
        self.assertIn(CTC_TRANSFORMER_TRAINER, ctc_paths)
        self.assertIn(CTC_TRANSFORMER_SHARED_MODEL, ctc_paths)
        self.assertIn(SEQ2SEQ_TRAINER, ctc_paths)
        self.assertEqual(
            {
                item.role
                for item in ctc_files
                if item.archive_path
                    in {
                        CTC_TRANSFORMER_TRAINER,
                        CTC_TRANSFORMER_SHARED_MODEL,
                        SEQ2SEQ_TRAINER,
                    }
            },
            {"trainer", "trainer-dependency"},
        )


def write_malicious_archive(
    path: Path,
    *,
    name: str,
    symbolic_link: bool,
) -> None:
    with path.open("xb") as raw:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            compresslevel=1,
            fileobj=raw,
            mtime=0,
        ) as compressed:
            with tarfile.open(
                fileobj=compressed,
                mode="w|",
                format=tarfile.USTAR_FORMAT,
            ) as archive:
                if symbolic_link:
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.SYMTYPE
                    member.linkname = "../../outside"
                    member.mode = 0o644
                    member.uid = 0
                    member.gid = 0
                    member.mtime = 0
                    archive.addfile(member)
                else:
                    payload = b"escape"
                    archive.addfile(
                        regular_tar_info(name, len(payload)),
                        io.BytesIO(payload),
                    )


if __name__ == "__main__":
    unittest.main()
