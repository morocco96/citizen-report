<?php
/**
 * Plugin Name: Citizen Reporter API
 * Description: Backend for the Citizen Reporter mobile app. Each incident is a normal WordPress post.
 *              Adds default incident categories, geolocation fields, login/register endpoints and CORS.
 * Version: 1.0.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/* ------------------------------------------------------------------
 * DEV ONLY: Application Passwords normally require HTTPS.
 * To test over plain http, add this to wp-config.php:
 *     define( 'CITIZEN_REPORTER_DEV', true );
 * Remove it in production.
 * ----------------------------------------------------------------*/
if ( defined( 'CITIZEN_REPORTER_DEV' ) && CITIZEN_REPORTER_DEV ) {
	add_filter( 'wp_is_application_passwords_available', '__return_true' );
}

/* 1. Default incident categories ---------------------------------- */
register_activation_hook( __FILE__, function () {
	$cats = array( 'Accident', 'Fighting', 'Rioting', 'Fire', 'Robbery', 'Flooding', 'Other' );
	foreach ( $cats as $c ) {
		if ( ! term_exists( $c, 'category' ) ) {
			wp_insert_term( $c, 'category' );
		}
	}
} );

/* 2. Geolocation fields exposed on the REST API -------------------- */
add_action( 'init', function () {
	$auth = function () {
		return current_user_can( 'edit_posts' );
	};
	foreach ( array( 'cr_latitude', 'cr_longitude' ) as $key ) {
		register_post_meta( 'post', $key, array(
			'type'          => 'number',
			'single'        => true,
			'show_in_rest'  => true,
			'auth_callback' => $auth,
		) );
	}
	register_post_meta( 'post', 'cr_address', array(
		'type'              => 'string',
		'single'            => true,
		'show_in_rest'      => true,
		'sanitize_callback' => 'sanitize_text_field',
		'auth_callback'     => $auth,
	) );
} );

/* 3. Login + register endpoints ------------------------------------
 * The app logs in once with username/password and receives an
 * Application Password, which it then uses for Basic auth on every
 * other request (posting incidents, uploading photos, "my incidents").
 * ----------------------------------------------------------------*/
function cr_issue_token( WP_User $user ) {
	if ( ! class_exists( 'WP_Application_Passwords' ) ) {
		return new WP_Error( 'cr_unsupported', 'WordPress 5.6 or newer is required.', array( 'status' => 500 ) );
	}
	$created = WP_Application_Passwords::create_new_application_password(
		$user->ID,
		array( 'name' => 'CitizenReporter-' . wp_generate_password( 6, false ) )
	);
	if ( is_wp_error( $created ) ) {
		return $created;
	}
	return array(
		'id'           => $user->ID,
		'username'     => $user->user_login,
		'name'         => $user->display_name,
		'app_password' => $created[0],
	);
}

add_action( 'rest_api_init', function () {

	register_rest_route( 'citizen-reporter/v1', '/login', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => function ( WP_REST_Request $req ) {
			$user = wp_authenticate( sanitize_user( $req['username'] ), (string) $req['password'] );
			if ( is_wp_error( $user ) ) {
				return new WP_Error( 'cr_bad_login', 'Wrong username or password.', array( 'status' => 401 ) );
			}
			return cr_issue_token( $user );
		},
	) );

	register_rest_route( 'citizen-reporter/v1', '/register', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => function ( WP_REST_Request $req ) {
			$username = sanitize_user( (string) $req['username'], true );
			$email    = sanitize_email( (string) $req['email'] );
			$password = (string) $req['password'];

			if ( strlen( $username ) < 3 ) {
				return new WP_Error( 'cr_username', 'Username must be at least 3 characters.', array( 'status' => 400 ) );
			}
			if ( ! is_email( $email ) ) {
				return new WP_Error( 'cr_email', 'Enter a valid email address.', array( 'status' => 400 ) );
			}
			if ( strlen( $password ) < 6 ) {
				return new WP_Error( 'cr_password', 'Password must be at least 6 characters.', array( 'status' => 400 ) );
			}
			if ( username_exists( $username ) || email_exists( $email ) ) {
				return new WP_Error( 'cr_exists', 'That username or email is already registered.', array( 'status' => 409 ) );
			}

			$id = wp_create_user( $username, $password, $email );
			if ( is_wp_error( $id ) ) {
				return new WP_Error( 'cr_failed', $id->get_error_message(), array( 'status' => 400 ) );
			}
			// "author" can publish posts and upload photos, but cannot touch other people's posts.
			wp_update_user( array( 'ID' => $id, 'role' => 'author' ) );
			return cr_issue_token( get_user_by( 'id', $id ) );
		},
	) );
} );

/* 4. CORS so the Cordova WebView can call the API ------------------- */
add_action( 'rest_api_init', function () {
	remove_filter( 'rest_pre_serve_request', 'rest_send_cors_headers' );
	add_filter( 'rest_pre_serve_request', function ( $value ) {
		header( 'Access-Control-Allow-Origin: *' );
		header( 'Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS' );
		header( 'Access-Control-Allow-Headers: Authorization, Content-Type, Content-Disposition, X-WP-Nonce' );
		header( 'Access-Control-Expose-Headers: X-WP-Total, X-WP-TotalPages' );
		return $value;
	} );
}, 15 );
