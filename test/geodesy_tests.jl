# Geodetic ↔ ECEF, checked against the conversion the viewer itself draws with.
#
# A consistent pair of wrong functions round-trips perfectly, so the gate here is not
# `geodetic(ecef(x)) ≈ x` but agreement with Cesium's `Ellipsoid.cartographicToCartesian` and
# `Cartographic.fromCartesian` over a fixed table of awkward points, on WGS84 and on a shape no
# planet has. The table is `tools/baseline/ellipsoid-reference.json`, computed by Cesium itself in
# `lib/ellipsoid-reference.mjs` and re-checked against a fresh Cesium run by
# `lib/core/src/ellipsoid-reference.test.mjs`.

@testitem "ecef agrees with Cesium's cartographicToCartesian" setup=[CesiumTable] begin
    for (_, e) in REFERENCE, p in e["points"]
        lon, lat, height = p["lonlat"]
        shape = (a = e["a"], b = e["b"])
        @test all(abs.(collect(ecef(lon, lat, height; ellipsoid = shape)) .- p["ecef"]) .< TOLERANCE_M)
    end
end

@testitem "geodetic agrees with Cesium's fromCartesian" setup=[CesiumTable] begin
    for (_, e) in REFERENCE, p in e["points"]
        x, y, z = p["ecef"]
        lon, lat, height = p["geodetic"]
        shape = (a = e["a"], b = e["b"])
        got = geodetic(x, y, z; ellipsoid = shape)
        # Metres along the parallel, metres along the meridian, metres of height.
        metres_per_degree = e["a"] * π / 180
        @test abs(rem(got[1] - lon, 360, RoundNearest)) * metres_per_degree * cosd(lat) < TOLERANCE_M
        @test abs(got[2] - lat) * metres_per_degree < TOLERANCE_M
        @test abs(got[3] - height) < TOLERANCE_M
    end
end

@testitem "conversions take and give whole payload matrices" begin
    lon, lat, height = [12.5, -71.0589, 180.0], [41.9, 42.3601, -89.9], [100.0, -30.0, 20_200_000.0]

    xyz = ecef(lon, lat, height)
    @test size(xyz) == (3, 3)
    @test xyz[:, 2] == collect(ecef(lon[2], lat[2], height[2]))     # column i is point i
    @test ecef(lon, lat) == ecef(lon, lat, 0)                       # height defaults to the surface
    @test ecef(lon, lat, 0.0)[:, 1] == collect(ecef(lon[1], lat[1]))

    back = geodetic(xyz)
    @test size(back) == (3, 3)
    @test back ≈ geodetic(xyz[1, :], xyz[2, :], xyz[3, :])
    @test back[1, :] ≈ lon && back[2, :] ≈ lat && back[3, :] ≈ height
    @test_throws "3 × N" geodetic(xyz[1:2, :])
    @test_throws "centre of the ellipsoid" geodetic(0, 0, 0)
end

@testitem "the angles are degrees, and the latitude is geodetic" begin
    # A quarter turn east of the prime meridian is the +y axis, not the +x one.
    @test ecef(90, 0)[2] ≈ Ellipsoids.WGS84.a
    @test ecef(0, 0)[1] ≈ Ellipsoids.WGS84.a
    @test ecef(0, 90)[3] ≈ Ellipsoids.WGS84.b

    # The surface normal at 45° geodetic latitude does not pass through the centre: the geocentric
    # angle of that point is smaller, by the ~0.19° that is the whole reason to be explicit about
    # which latitude this is.
    x, y, z = ecef(0, 45)
    @test rad2deg(atan(z, hypot(x, y))) ≈ 44.8076 atol = 1e-4
end

@testitem "a conversion follows the ellipsoid its server declared" begin
    mars = (a = 3396190.0, b = 3376200.0)
    on_wgs84 = start_server(; host = "::1", port = 0)
    on_mars = start_server(; host = "::1", port = 0, ellipsoid = mars)
    try
        # A server that declared nothing converts on WGS84 — the shape its viewer keeps — rather
        # than refusing to convert at all.
        @test ecef(12.5, 41.9; ellipsoid = on_wgs84) == ecef(12.5, 41.9; ellipsoid = Ellipsoids.WGS84)
        @test ecef(12.5, 41.9; ellipsoid = on_wgs84) == ecef(12.5, 41.9)
        @test ecef(12.5, 41.9; ellipsoid = on_mars) == ecef(12.5, 41.9; ellipsoid = mars)
        @test ecef(0, 0; ellipsoid = on_mars)[1] ≈ mars.a
        @test geodetic(ecef(12.5, 41.9, 100; ellipsoid = on_mars)...; ellipsoid = on_mars)[3] ≈ 100 atol = 1e-6
    finally
        stop_server(on_wgs84)
        stop_server(on_mars)
    end
end
