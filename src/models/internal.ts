/** Core domain types.
 *
 * Field names deliberately keep the Python snake_case: they carry unit suffixes
 * (`cg_height_m`, `pad_swept_outer_diameter_mm`) that are the whole point, and
 * matching them exactly lets the golden fixtures decode straight into these
 * shapes with no rename layer to get wrong. Functions are idiomatic camelCase. */

export interface Vehicle {
  mass_without_driver_kg: number;
  static_front_weight_fraction: number;
  wheelbase_m: number;
  front_track_m: number;
  rear_track_m: number;
  cg_height_m: number;
  tire_rolling_radius_m: number;
}

export interface DriverMassSweep {
  min_kg: number;
  max_kg: number;
  points: number;
}

export interface Caliper {
  name: string;
  piston_count: number;
  piston_diameter_mm: number;
  area_convention: string;
}

export interface AxleBrake {
  rotor_outer_diameter_mm: number;
  rotor_thickness_mm: number;
  rotor_mass_kg: number;
  pad_height_mm: number;
  caliper: Caliper;
  rotor_material?: string | null;
  pad_swept_outer_diameter_mm?: number | null;
  pad_swept_inner_diameter_mm?: number | null;
  bobbin_count?: number | null;
  bobbin_circle_diameter_mm?: number | null;
  bobbin_button_diameter_mm?: number | null;
  bobbin_material?: string | null;
}

export interface BrakeHardware {
  front: AxleBrake;
  rear: AxleBrake;
  front_pressure_fraction: number;
  rear_pressure_fraction: number;
  front_master_cylinder_bore_mm: number;
  rear_master_cylinder_bore_mm: number;
  pedal_ratio: number;
  pedal_efficiency: number;
  max_pedal_travel_deg: number;
  pad_friction_coefficient?: number | null;
  pad_friction_model?: unknown | null;
  pedal_arm_length_mm?: number | null;
  caliper_stiffness_n_per_m?: number | null;
  system_fluid_volume_ml?: number | null;
  line_rated_pressure_pa?: number | null;
}

export interface StraightLineEvent {
  initial_speed_mph: number;
  final_speed_mph: number;
  target_deceleration_g: number;
}

export interface CoolingParameters {
  convection_coefficient_w_m2k: number;
  emissivity: number;
  ambient_temperature_c: number;
  allowable_rotor_temperature_c: number;
  vane_area_multiplier?: number;
  air_specific_heat_j_kgk?: number;
  air_density_kg_m3?: number;
  cooling_air_delta_t_c?: number;
  rotor_heat_fraction?: number;
}
