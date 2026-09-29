use super::*;

fn binding(user: &str, group: Option<&str>, session: &str) -> ChannelConversationBinding {
    ChannelConversationBinding {
        conversation_id: format!("wecom:{user}-{session}"),
        installation_id: serde_json::to_string(&InstallationIdentity {
            bot_id: "bot".into(),
            channel: "wecom".into(),
            connector_id: "connector".into(),
            tenant_id: "tenant".into(),
        })
        .unwrap(),
        scope_key: format!(
            "v1:{}",
            serde_json::to_string(&[
                if group.is_some() { "group" } else { "single" },
                group.unwrap_or("direct"),
                user,
            ])
            .unwrap()
        ),
        session_id: session.into(),
        generation: 1,
        lifecycle_version: 1,
    }
}

fn write(store: &MemoryStore, text: &str) {
    dispatch_scoped(
        store,
        "memory_write",
        json!({"args": {
            "slug":"format-preference", "scope":"global", "memoryType":"user",
            "description":"Preferred answer format", "body":text, "actor":"user"
        }}),
    )
    .unwrap();
}

fn read(store: &MemoryStore) -> Value {
    dispatch_scoped(
        store,
        "memory_read",
        json!({"args": {
            "slug":"format-preference", "scope":"global"
        }}),
    )
    .unwrap()
}

#[test]
fn spaces_separate_people_groups_installations_and_local_without_changing_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let registry = MemoryStoreRegistry::at(temp.path().join("channel-memory"));
    let local = MemoryStore::open_at(temp.path().join("memory")).unwrap();
    let alice = identity_from_binding(&binding("Alice", None, "s1")).unwrap();
    let alice_new = identity_from_binding(&binding("Alice", None, "s2")).unwrap();
    let bob = identity_from_binding(&binding("Bob", None, "s1")).unwrap();
    let group_a = identity_from_binding(&binding("Alice", Some("G1"), "s1")).unwrap();
    let group_b = identity_from_binding(&binding("Alice", Some("G2"), "s1")).unwrap();
    let group_bob = identity_from_binding(&binding("Bob", Some("G1"), "s1")).unwrap();
    let mut other_installation = binding("Alice", None, "s1");
    other_installation.installation_id = other_installation
        .installation_id
        .replace("\"tenant\"", "\"other\"");
    let other = identity_from_binding(&other_installation).unwrap();
    assert_eq!(alice, alice_new);
    let identities = [&alice, &bob, &group_a, &group_b, &group_bob, &other];
    assert_eq!(
        identities
            .iter()
            .map(|identity| &identity.space_id)
            .collect::<HashSet<_>>()
            .len(),
        6
    );
    let alice_store = registry.store_for(&alice).unwrap();
    let bob_store = registry.store_for(&bob).unwrap();
    assert!(Arc::ptr_eq(
        &alice_store,
        &registry.store_for(&alice_new).unwrap()
    ));
    write(&local, "local preference");
    write(&alice_store, "Alice prefers ten thousand yuan");
    write(&bob_store, "Bob prefers hundred million yuan");
    assert_eq!(
        read(&alice_store)["body"],
        "Alice prefers ten thousand yuan"
    );
    assert_eq!(read(&bob_store)["body"], "Bob prefers hundred million yuan");
    assert_eq!(read(&local)["body"], "local preference");
    let group_store = registry.store_for(&group_a).unwrap();
    assert!(dispatch_scoped(
        &group_store,
        "memory_read",
        json!({"args":{
            "slug":"format-preference", "scope":"global"
        }})
    )
    .is_err());
    drop(group_store);
    drop(alice_store);
    drop(bob_store);
    drop(registry);
    let restarted = MemoryStoreRegistry::at(temp.path().join("channel-memory"));
    assert_eq!(
        read(&restarted.store_for(&alice_new).unwrap())["body"],
        "Alice prefers ten thousand yuan"
    );
    assert_eq!(
        read(&restarted.store_for(&bob).unwrap())["body"],
        "Bob prefers hundred million yuan"
    );
}

#[test]
fn concurrent_space_resolution_reuses_one_live_store() {
    let temp = tempfile::tempdir().unwrap();
    let registry = Arc::new(MemoryStoreRegistry::at(temp.path().join("channel-memory")));
    let threads = (0..8)
        .map(|_| {
            let registry = Arc::clone(&registry);
            std::thread::spawn(move || {
                registry
                    .store_for(&identity_from_binding(&binding("Alice", None, "session")).unwrap())
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    let stores = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert!(stores.iter().all(|store| Arc::ptr_eq(&stores[0], store)));
}

#[test]
fn unknown_malformed_and_conflicting_bindings_fail_closed() {
    let valid = binding("Alice", None, "session");
    assert!(resolve_identity(&valid.conversation_id, &[])
        .unwrap_err()
        .contains("unbound"));
    assert!(resolve_identity("desktop", &[valid.clone()]).is_err());
    let mut bob = binding("Bob", None, "session");
    bob.conversation_id = valid.conversation_id.clone();
    assert!(
        resolve_identity(&valid.conversation_id, &[valid.clone(), bob])
            .unwrap_err()
            .contains("ambiguous")
    );
    for bad_scope in [
        "v1:[\"single\", \"direct\",\"Alice\"]", // noncanonical
        "v1:[\"direct\",\"direct\",\"Alice\"]",  // not connector's single type
        "v1:[\"single\",\"other\",\"Alice\"]",
        "v1:[\"group\",\"\",\"Alice\"]",
        "v1:[\"single\",\"direct\",\"\"]",
        "v1:[\"single\",\"direct\",\" Alice\"]",
        "v2:[\"single\",\"direct\",\"Alice\"]",
        "v1:[\"single\",\"direct\",\"Alice\",\"other\"]",
    ] {
        let mut invalid = valid.clone();
        invalid.scope_key = bad_scope.into();
        assert!(
            identity_from_binding(&invalid).is_err(),
            "accepted {bad_scope}"
        );
    }
    for version in [0, 2] {
        let mut invalid = valid.clone();
        invalid.lifecycle_version = version;
        assert!(identity_from_binding(&invalid).is_err());
    }
    let mut invalid = valid.clone();
    invalid.installation_id = invalid.installation_id.replace("wecom", "desktop");
    assert!(identity_from_binding(&invalid).is_err());
    let mut invalid = valid;
    invalid.installation_id = "{}".into();
    assert!(identity_from_binding(&invalid).is_err());
}

#[test]
fn memory_policy_requires_explicit_enable_and_constrains_paths_and_batch_hashes() {
    for policy in [
        json!({}),
        json!({"memoryEnabled":false}),
        json!({"memoryEnabled":"true"}),
    ] {
        assert!(constrain_payload(&mut json!({}), &policy, "wecom:alice")
            .unwrap_err()
            .contains("memory_disabled"));
    }
    let temp = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let workdir = temp.path().to_string_lossy().to_string();
    let other_workdir = other.path().to_string_lossy().to_string();
    let policy = json!({"memoryEnabled":true,"workdir":workdir});
    let allowed = optional_workdir_hash(Some(&workdir)).unwrap().unwrap();
    let denied = optional_workdir_hash(Some(&other_workdir))
        .unwrap()
        .unwrap();
    for mut payload in [
        json!({"workdir":other_workdir}),
        json!({"args":{"workdir":other_workdir}}),
        json!({"args":{"workdirHash":denied}}),
        json!({"args":{"decisions":[{"workdirHash":denied}]}}),
    ] {
        assert!(constrain_payload(&mut payload, &policy, "wecom:alice")
            .unwrap_err()
            .contains("memory_workdir_denied"));
    }
    let mut payload = json!({"args":{
        "workdirHash":allowed, "includeAllProjects":true, "includeHistory":true,
        "conversationId":"wecom:other", "decisions":[{"workdirHash":allowed}]
    }});
    constrain_payload(&mut payload, &policy, "wecom:alice").unwrap();
    assert_eq!(payload["workdir"], workdir);
    assert_eq!(payload["args"]["workdir"], workdir);
    assert_eq!(payload["args"]["includeAllProjects"], false);
    assert_eq!(payload["args"]["includeHistory"], false);
    assert_eq!(payload["args"]["conversationId"], "wecom:alice");
    let mut no_project = json!({"args":{"workdirHash":allowed}});
    assert!(constrain_payload(
        &mut no_project,
        &json!({"memoryEnabled":true}),
        "wecom:alice"
    )
    .is_err());
}

#[test]
fn policy_is_rechecked_for_delayed_operations_and_never_opens_local_store() {
    use crate::services::channel_control::EnsureInstallationDefault;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("channel-memory");
    let registry = MemoryStoreRegistry::at(root.clone());
    let control = ChannelControlStore::open_in_memory().unwrap();
    let alice = binding("Alice", None, "session");
    let context = MemoryAccessContext {
        conversation_id: alice.conversation_id.clone(),
    };
    let resolve = || registry.resolve_bound(&context, &[alice.clone()], &control, &mut json!({}));
    assert!(resolve().is_err());
    assert!(!root.exists());
    control
        .ensure_installation_default(EnsureInstallationDefault {
            installation_id: alice.installation_id.clone(),
            name: "WeCom".into(),
            policy: json!({"executionMode":"text","memoryEnabled":true}),
        })
        .unwrap();
    let store = resolve().unwrap();
    write(&store, "Alice's preference");
    assert!(root.exists());
    control
        .ensure_installation_default(EnsureInstallationDefault {
            installation_id: alice.installation_id.clone(),
            name: "WeCom".into(),
            policy: json!({"executionMode":"text","memoryEnabled":false}),
        })
        .unwrap();
    assert!(matches!(resolve(), Err(error) if error.contains("memory_disabled")));
    assert!(registry
        .resolve_bound(&context, &[], &control, &mut json!({}))
        .is_err());
    assert!(!temp.path().join("memory").exists());
}

#[test]
fn conversation_permission_override_is_used_for_both_direct_and_group_memory() {
    use crate::services::channel_control::{
        EnsureInstallationDefault, SavePermissionProfile, SavePrincipalBinding,
    };
    let temp = tempfile::tempdir().unwrap();
    let registry = MemoryStoreRegistry::at(temp.path().join("channel-memory"));
    let control = ChannelControlStore::open_in_memory().unwrap();
    for group in [None, Some("finance-group")] {
        let binding = binding("Alice", group, group.unwrap_or("direct"));
        control
            .ensure_installation_default(EnsureInstallationDefault {
                installation_id: binding.installation_id.clone(),
                name: "WeCom".into(),
                policy: json!({"executionMode":"text","memoryEnabled":true}),
            })
            .unwrap();
        let profile = control
            .save_profile(SavePermissionProfile {
                id: None,
                name: "No memory in this conversation".into(),
                enabled: true,
                policy: json!({"executionMode":"text","memoryEnabled":false}),
            })
            .unwrap();
        control
            .bind_principal(SavePrincipalBinding {
                id: None,
                installation_id: binding.installation_id.clone(),
                principal_type: "conversation".into(),
                principal_id: binding.conversation_id.clone(),
                profile_id: profile.id,
            })
            .unwrap();
        let context = MemoryAccessContext {
            conversation_id: binding.conversation_id.clone(),
        };
        assert!(matches!(
            registry.resolve_bound(&context, &[binding], &control, &mut json!({})),
            Err(error) if error.contains("memory_disabled")
        ));
    }
    assert!(!temp.path().join("channel-memory").exists());
}

#[test]
fn scoped_dispatch_isolates_daily_organizer_quota_and_disables_history() {
    let temp = tempfile::tempdir().unwrap();
    let registry = MemoryStoreRegistry::at(temp.path().join("channel-memory"));
    let alice = registry
        .store_for(&identity_from_binding(&binding("Alice", None, "session")).unwrap())
        .unwrap();
    let bob = registry
        .store_for(&identity_from_binding(&binding("Bob", None, "session")).unwrap())
        .unwrap();
    write(&alice, "format preference only belongs to Alice");
    let today = alice.today_local_date(None);
    dispatch_scoped(
        &alice,
        "memory_apply_batch",
        json!({"args":{
            "localDate":today, "dailyAppend":{"bullet":"Alice requested a concise answer"}
        }}),
    )
    .unwrap();
    assert!(!dispatch_scoped(&alice, "memory_today_daily", json!({}))
        .unwrap()
        .is_null());
    assert!(dispatch_scoped(&bob, "memory_today_daily", json!({}))
        .unwrap()
        .is_null());
    let run = dispatch_scoped(
        &alice,
        "memory_organize_run_create",
        json!({"args":{"trigger":"manual"}}),
    )
    .unwrap();
    let run_id = run["run"]["runId"].as_str().unwrap();
    assert!(dispatch_scoped(
        &bob,
        "memory_organize_run_read",
        json!({"args":{"runId":run_id}})
    )
    .unwrap()
    .is_null());
    let search = dispatch_scoped(
        &alice,
        "memory_search",
        json!({"args":{"query":"preference","includeHistory":true}}),
    )
    .unwrap();
    assert!(!search["matches"].as_array().unwrap().is_empty());
    assert!(search["historyMatches"].as_array().unwrap().is_empty());
    let other_search = dispatch_scoped(
        &bob,
        "memory_search",
        json!({"args":{"query":"preference","includeHistory":true}}),
    )
    .unwrap();
    assert!(other_search["matches"].as_array().unwrap().is_empty());
    let quota = dispatch_scoped(&bob, "memory_quota_summary", json!({})).unwrap();
    assert_eq!(quota["scopes"][0]["used"], 0);
    assert!(dispatch_scoped(&alice, "arbitrary_other_command", json!({})).is_err());
}
