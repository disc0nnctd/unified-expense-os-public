from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant


def test_push_subscription_create_update_delete(client):
    now = datetime.now(UTC).isoformat()
    token = register_participant(client, "alice", "Alice", now)

    create = client.post(
        "/push/subscriptions",
        headers=auth_header(token),
        json={"endpoint": "https://push.example/abc", "p256dh_key": "key1", "auth_key": "auth1"},
    )
    assert create.status_code == 204

    # Re-subscribing with the same endpoint updates rather than duplicates.
    update = client.post(
        "/push/subscriptions",
        headers=auth_header(token),
        json={"endpoint": "https://push.example/abc", "p256dh_key": "key2", "auth_key": "auth2"},
    )
    assert update.status_code == 204

    delete = client.delete(
        "/push/subscriptions",
        headers=auth_header(token),
        params={"endpoint": "https://push.example/abc"},
    )
    assert delete.status_code == 204


def test_push_subscription_requires_auth(client):
    response = client.post(
        "/push/subscriptions",
        json={"endpoint": "https://push.example/abc", "p256dh_key": "key1", "auth_key": "auth1"},
    )
    assert response.status_code == 401
